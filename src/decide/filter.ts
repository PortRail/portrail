import { globToRegExp } from "./match.ts";
import type { SearchFilter, SearchGlob } from "../types.ts";

/**
 * Expand `{a,b}` alternatives the way ripgrep does, nested ones included:
 * `*.{ts,tsx}` → `*.ts`, `*.tsx`. Returns null when the braces do not balance or an
 * alternation is empty — a pattern we cannot read is not one we can judge.
 */
export function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf("{");
  if (open < 0) return pattern.includes("}") ? null : [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length; index++) {
    if (pattern[index] === "{") depth++;
    else if (pattern[index] === "}") {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return null;
  const inside = pattern.slice(open + 1, close);
  if (!inside) return null;
  const alternatives: string[] = [];
  let level = 0;
  let current = "";
  for (const character of inside) {
    if (character === "{") level++;
    if (character === "}") level--;
    if (character === "," && level === 0) {
      alternatives.push(current);
      current = "";
    } else current += character;
  }
  alternatives.push(current);
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alternative of alternatives) {
    const expanded = expandBraces(prefix + alternative + suffix);
    if (!expanded) return null;
    out.push(...expanded);
  }
  return out;
}

/**
 * ripgrep's built-in file types, as globs. Every extension any ripgrep version has
 * given the type is listed, because a type that misses one lets a file through that
 * rg would open. `sh` is deliberately absent: it covers `.env` itself.
 */
const RG_TYPES: Record<string, readonly string[]> = {
  js: ["*.js", "*.jsx", "*.vue", "*.cjs", "*.mjs"],
  ts: ["*.ts", "*.tsx", "*.cts", "*.mts"],
  typescript: ["*.ts", "*.tsx", "*.cts", "*.mts"],
  py: ["*.py", "*.pyi", "*.pyx", "*.pyw"],
  python: ["*.py", "*.pyi", "*.pyx", "*.pyw"],
  rust: ["*.rs"],
  go: ["*.go"],
  java: ["*.java", "*.jsp", "*.jspx", "*.properties"],
  json: ["*.json", "composer.lock", "*.sarif"],
  md: ["*.md", "*.markdown", "*.mdown", "*.mkdn", "*.mdwn", "*.mkd"],
  markdown: ["*.md", "*.markdown", "*.mdown", "*.mkdn", "*.mdwn", "*.mkd"],
  yaml: ["*.yaml", "*.yml"],
  toml: ["*.toml", "Cargo.lock"],
  css: ["*.css", "*.scss"],
  html: ["*.htm", "*.html", "*.ejs"],
};

/** A file as the walk found it, described the way the tool's globs are matched. */
export interface Candidate {
  /** Base name. */
  name: string;
  /** Path from the tool's working directory with forward slashes, or null when the file is not beneath it. */
  fromCwd: string | null;
  /** The directories between the search root and the file, nearest the root first. */
  dirs: Array<{ name: string; rel: string | null }>;
}

interface Compiled {
  exclude: boolean;
  /** Matches the base name (unanchored) or the path from the working directory (anchored). */
  test: (name: string, fromCwd: string | null) => boolean | "unknown";
  files: boolean;
  dirs: boolean;
}

/** Glob syntax we do not read: character classes, escapes, whitespace, comments. */
const UNREADABLE = /[[\\\]\s]|^#/;

function compileGlob(glob: SearchGlob): Compiled | null {
  if (glob.dialect === "grep-dir") {
    if (UNREADABLE.test(glob.pattern)) return null;
    const expression = globToRegExp(glob.pattern, false, {
      ignoreCase: glob.ignoreCase === true,
    });
    return {
      exclude: true,
      files: false,
      dirs: true,
      test: (name) => expression.test(name),
    };
  }
  if (glob.dialect === "grep") {
    if (UNREADABLE.test(glob.pattern)) return null;
    // An include may over-match (case, path); an exclude must only match what grep excludes.
    const expression = globToRegExp(glob.pattern, false, {
      ignoreCase: glob.exclude ? glob.ignoreCase === true : true,
    });
    return {
      exclude: glob.exclude,
      files: true,
      dirs: false,
      test: (name, fromCwd) =>
        expression.test(name) ||
        (!glob.exclude && fromCwd !== null && expression.test(fromCwd)),
    };
  }
  const expanded = expandBraces(glob.pattern);
  if (
    !expanded ||
    expanded.some((pattern) => UNREADABLE.test(pattern) || pattern === "")
  )
    return null;
  const compiled = expanded.map((pattern) => {
    const dirOnly = pattern.endsWith("/");
    let body = dirOnly ? pattern.slice(0, -1) : pattern;
    const anchored = body.startsWith("/") || body.includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    return {
      dirOnly,
      anchored,
      expression: globToRegExp(body, true, {
        ignoreCase: glob.exclude ? glob.ignoreCase === true : true,
      }),
    };
  });
  return {
    exclude: glob.exclude,
    files: compiled.some((c) => !c.dirOnly),
    dirs: true,
    test: (name, fromCwd) => {
      let unknown = false;
      for (const c of compiled) {
        if (c.anchored) {
          if (fromCwd === null) unknown = true;
          else if (c.expression.test(fromCwd)) return true;
        } else if (c.expression.test(name)) return true;
      }
      return unknown ? "unknown" : false;
    },
  };
}

/**
 * Turn a tool's filters into "would the tool open this file?". Null means the filter
 * cannot be read with confidence, and the search is judged over every file as before.
 *
 * Includes may match too much (extra reach only refuses more); excludes must never
 * match too much (a wrong exclude would hide a file the tool opens). An include we
 * cannot read disables narrowing; an exclude we cannot read is dropped.
 */
export function compileFilter(
  filter: SearchFilter,
): ((candidate: Candidate) => boolean) | null {
  const globs: Compiled[] = [];
  for (const glob of filter.globs) {
    const compiled = compileGlob(glob);
    if (!compiled) {
      if (!glob.exclude) return null;
      continue;
    }
    globs.push(compiled);
  }
  const typePatterns = filter.types.map((type) => RG_TYPES[type]);
  const typeMatches =
    !filter.types.length || typePatterns.some((patterns) => patterns === undefined)
      ? () => true
      : (() => {
          const expressions = typePatterns.flatMap((patterns) =>
            patterns!.map((pattern) => globToRegExp(pattern, true)),
          );
          return (name: string) =>
            expressions.some((expression) => expression.test(name));
        })();

  /** The last glob that speaks about this entry, or its verdict when we cannot tell. */
  const lastMatch = (
    name: string,
    fromCwd: string | null,
    kind: "file" | "dir",
  ): Compiled | "unknown" | null => {
    let last: Compiled | "unknown" | null = null;
    for (const glob of globs) {
      if (kind === "file" ? !glob.files : !glob.dirs) continue;
      const result = glob.test(name, fromCwd);
      if (result === true) last = glob;
      else if (result === "unknown") last = last === null ? "unknown" : last;
    }
    return last;
  };

  return (candidate) => {
    for (const dir of candidate.dirs) {
      const last = lastMatch(dir.name, dir.rel, "dir");
      if (last !== null && last !== "unknown" && last.exclude) return false;
    }
    const last = lastMatch(candidate.name, candidate.fromCwd, "file");
    // A file we cannot anchor might be opened by an include, and is never assumed excluded.
    if (last === "unknown") return true;
    if (last) return !last.exclude;
    if (filter.unmatched === "drop") return false;
    return typeMatches(candidate.name);
  };
}
