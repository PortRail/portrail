import { realpathSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import type { Operation, OperationKind, SearchFilter } from "../types.ts";
import { isWithin } from "../core/paths.ts";
import { holdsGitCredentials } from "../core/protected.ts";
import { REACH_LIMIT, reachableFiles } from "../core/reach.ts";
import { parseCommand, type CommandSegment } from "./command.ts";
import { compileFilter, type Candidate } from "./filter.ts";
import { gitIgnored } from "./ignored.ts";
import { recursiveReadOf } from "./recursive.ts";
import { sedObjection } from "./sed.ts";

/**
 * One segment of a command line, with everything a rule may judge worked out: the
 * program that runs (by name, whatever it was called on the line), the forms a deny
 * or an allow rule may match, and whether a sed script does more than print.
 */
export interface AnalysedSegment extends CommandSegment {
  /** The program that runs, as a name: the lower-cased basename of the word after any wrappers. */
  program: string;
  /**
   * What a deny rule may match: the line as written, with wrappers removed, with the
   * program reduced to its name, and the `<stdin>` forms when xargs feeds it.
   */
  denyForms: string[];
  /** What an allow or ask rule may match: the line as written or with wrappers removed. */
  allowForms: string[];
  /** For sed and gsed: why the script does more than print or filter, else null. */
  sedObjection: string | null;
}

/** A directory a search opens, and what the tool would actually read beneath it. */
export interface SearchReach {
  /** Index into `segments` of the command that searches; null for a recursive read. */
  segment: number | null;
  /** The directory searched, workspace-relative. */
  where: string;
  /**
   * The files the tool opens, workspace-relative: after its own filters, and without
   * the suspect files git ignores when the tool honours .gitignore.
   */
  files: string[];
  /** A refusal no rule can lift: too many files to judge, or a link followed out of the workspace. */
  refused: string | null;
}

/** What an operation touches, in the terms rules are written in. */
export interface OperationAnalysis {
  kind: OperationKind;
  /** For a command: what the text hides from a rule, else null. When set, nothing else is analysed. */
  unjudgeable: string | null;
  /** The command's segments; empty for any other kind. */
  segments: AnalysedSegment[];
  /** A read's paths or a write's changed paths, workspace-relative. */
  paths: string[];
  /** The files a command names, as containment resolved them, workspace-relative. */
  namedPaths: string[];
  /** Every directory search the operation performs, in order, up to the first refusal. */
  searches: SearchReach[];
  /** A net operation's host or a tool's `server/tool`; null otherwise. */
  subject: string | null;
}

export interface AnalysisOptions {
  workspaceRoot: string;
  /** Files a search may reach before it is refused as unjudgeable. */
  reachLimit?: number;
  /**
   * Which reached files a rule would object to. Only those are asked of git, and only
   * they are dropped when git ignores them and the tool honours .gitignore.
   */
  suspect?: (relativePath: string) => boolean;
}

/**
 * Work out what an operation touches: the segments of a command line in every form
 * a rule may match, the files it names, the files every search it performs would
 * open. The built-in decider judges from this, and so can an extension's decider,
 * so what one refuses the other cannot let through by parsing differently.
 */
export async function analyseOperation(
  operation: Operation,
  options: AnalysisOptions,
): Promise<OperationAnalysis> {
  const root = options.workspaceRoot;
  const limit = options.reachLimit ?? REACH_LIMIT;
  const analysis: OperationAnalysis = {
    kind: operation.kind,
    unjudgeable: null,
    segments: [],
    paths: [],
    namedPaths: [],
    searches: [],
    subject: null,
  };
  switch (operation.kind) {
    case "read":
      analysis.paths = operation.paths.map((path) => relativise(root, path));
      // Claude's Grep runs `rg --hidden`: dotfiles too, symlinks not followed, .gitignore honoured.
      if (operation.recursive)
        analysis.searches = await reach(
          operation.paths,
          {
            hidden: true,
            follow: false,
            respectsIgnore: true,
            filter: operation.filter,
            cwd: root,
          },
          null,
          root,
          limit,
          options.suspect,
        );
      return analysis;
    case "write":
      analysis.paths = operation.changes.map((change) => relativise(root, change.path));
      return analysis;
    case "net":
      analysis.subject = operation.host ?? operation.url ?? "*";
      return analysis;
    case "tool":
      analysis.subject = `${operation.server}/${operation.tool}`;
      return analysis;
    case "exec": {
      const parsed = parseCommand(operation.command);
      if (parsed.unjudgeable) {
        analysis.unjudgeable = parsed.unjudgeable;
        return analysis;
      }
      analysis.segments = parsed.segments.map(analyseSegment);
      // A command that names a file is a read of that file, whatever the file is
      // called on the command line: containment resolved the names to what is on disk.
      analysis.namedPaths = (operation.paths ?? []).map((path) =>
        relativise(root, path),
      );
      // `grep -r`, `rg`, `diff -r`: a command that searches a directory reaches what is in it.
      for (const [index, segment] of analysis.segments.entries()) {
        const search = recursiveReadOf(
          [segment.program, ...segment.words.slice(segment.programIndex + 1)],
          operation.cwd,
        );
        if (!search) continue;
        const reached = await reach(
          search.dirs,
          { ...search, cwd: operation.cwd },
          index,
          root,
          limit,
          options.suspect,
        );
        analysis.searches.push(...reached);
        if (reached.some((entry) => entry.refused)) break;
      }
      return analysis;
    }
  }
}

function analyseSegment(segment: CommandSegment): AnalysedSegment {
  const program = basename(segment.words[segment.programIndex] ?? "").toLowerCase();
  const denyForms = [
    ...new Set([
      segment.text,
      segment.unwrapped,
      segment.named,
      // A program fed by xargs runs with words we cannot see; `curl *` must still see it.
      ...(segment.fed
        ? [`${segment.unwrapped} <stdin>`, `${segment.named} <stdin>`]
        : []),
    ]),
  ];
  const allowForms = [...new Set([segment.text, segment.unwrapped])];
  const objection =
    program === "sed" || program === "gsed"
      ? sedObjection([program, ...segment.words.slice(segment.programIndex + 1)])
      : null;
  return { ...segment, program, denyForms, allowForms, sedObjection: objection };
}

/**
 * Walk every directory a search opens and list what the tool would read there. The
 * walk stops at the first directory that cannot be bounded; that search is reported
 * refused and later ones are not walked.
 */
async function reach(
  dirs: readonly string[],
  search: {
    hidden: boolean;
    follow: boolean;
    respectsIgnore: boolean;
    filter?: SearchFilter;
    cwd: string;
  },
  segment: number | null,
  root: string,
  limit: number,
  suspect: ((relativePath: string) => boolean) | undefined,
): Promise<SearchReach[]> {
  const searches: SearchReach[] = [];
  for (const dir of dirs) {
    if (!isDirectory(dir)) continue;
    const where = relativise(root, dir);
    const walk = reachableFiles(dir, root, {
      hidden: search.hidden,
      follow: search.follow,
      limit,
    });
    if (walk.truncated) {
      searches.push({
        segment,
        where,
        files: [],
        refused: `Refused: a search over ${where} reaches too many files to judge (more than ${limit}). Search a narrower path.`,
      });
      return searches;
    }
    if (walk.outside) {
      searches.push({
        segment,
        where,
        files: [],
        refused: `Refused: a search over ${where} would follow ${relativise(root, walk.outside)} out of the workspace.`,
      });
      return searches;
    }
    // Files the tool would never open — outside its globs or types — cannot be reached by it.
    const keep = search.filter ? compileFilter(search.filter) : null;
    const opened = keep
      ? walk.files.filter((file) => keep(candidate(file, dir, search.cwd)))
      : walk.files;
    const named = opened.map((file) => [file, relativise(root, file)] as const);
    // A tool that honours .gitignore never opens what git ignores; only the files a
    // rule would object to are worth asking git about.
    const suspects =
      suspect && search.respectsIgnore
        ? named.filter(([, relativePath]) => suspect(relativePath))
        : [];
    const ignored = suspects.length
      ? await gitIgnored(
          root,
          suspects.map(([file]) => file),
        )
      : new Set<string>();
    const kept = named.filter(([file]) => !ignored.has(file));
    const files = kept.map(([, path]) => path);
    // The workspace's own credentials are not a matter of rules: a search that would
    // open one is refused here, where no decider can lift it.
    const secret = kept.find(([file, path]) => holdsGitCredentials(file, path))?.[1];
    if (secret) {
      searches.push({
        segment,
        where,
        files: [],
        refused: `Refused: a search over ${where} reaches ${secret}, which is protected in every workspace. Search a narrower path.`,
      });
      return searches;
    }
    searches.push({ segment, where, files, refused: null });
  }
  return searches;
}

/**
 * A reached file described the way a search tool's globs see it: its name, its path
 * from the tool's working directory, and the directories between the search root and
 * it (which an excluded directory name prunes).
 */
function candidate(file: string, searchRoot: string, cwd: string): Candidate {
  const realRoot = safeReal(searchRoot);
  const realCwd = safeReal(cwd);
  const fromCwd = isWithin(file, realCwd)
    ? relative(realCwd, file).split(sep).join("/")
    : null;
  const between = isWithin(file, realRoot)
    ? relative(realRoot, file).split(sep)
    : [basename(file)];
  // The search root may itself sit below the working directory: those leading parts belong to every dir's path.
  const fromCwdParts = fromCwd?.split("/") ?? [];
  const lead = fromCwdParts.length - between.length;
  const dirs = between.slice(0, -1).map((name, index) => ({
    name,
    rel: fromCwd === null ? null : fromCwdParts.slice(0, lead + index + 1).join("/"),
  }));
  return { name: basename(file), fromCwd, dirs };
}

function safeReal(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A path as the rules see it: relative to the workspace, forward slashes. */
export function relativise(workspaceRoot: string, path: string): string {
  const full = resolve(workspaceRoot, path);
  const inside = relative(workspaceRoot, full);
  // Paths outside the workspace are rejected before we get here, but be explicit.
  return inside === "" ? "." : inside.split(sep).join("/");
}
