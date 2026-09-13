import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { SearchFilter, SearchGlob } from "../types.ts";

/** What a recursive search in a command can reach, and how the tool walks. */
export interface RecursiveRead {
  dirs: string[];
  /** The tool reads dotfiles. */
  hidden: boolean;
  /** The tool follows symlinks it meets while walking. */
  follow: boolean;
  /** The tool skips what .gitignore names. */
  respectsIgnore: boolean;
  /** The include and exclude filters the tool was given, when it was given any. */
  filter?: SearchFilter;
}

/** rg's `-g`/`--glob`/`--iglob` and `-t`/`--type`, as the tool reads them. */
function rgFilter(parsed: Parsed): SearchFilter | undefined {
  const globs: SearchGlob[] = [];
  const types: string[] = [];
  let typesUsable = true;
  for (const { flag, value } of parsed.values) {
    if (flag === "-g" || flag === "--glob" || flag === "--iglob") {
      const exclude = value.startsWith("!");
      globs.push({
        pattern: exclude ? value.slice(1) : value,
        exclude,
        dialect: "rg",
        ...(flag === "--iglob" ? { ignoreCase: true } : {}),
      });
    } else if (flag === "-t" || flag === "--type") types.push(value);
    // A custom, cleared or negated type is a list we do not know: narrow nothing by type.
    else if (["-T", "--type-not", "--type-add", "--type-clear"].includes(flag))
      typesUsable = false;
  }
  if (!globs.length && !types.length) return undefined;
  return {
    globs,
    types: typesUsable ? types : [],
    unmatched: globs.some((glob) => !glob.exclude) ? "drop" : "keep",
  };
}

/** grep's `--include`, `--exclude` and `--exclude-dir`. Unmatched files are kept unless the first filter was an include. */
function grepFilter(parsed: Parsed): SearchFilter | undefined {
  const globs: SearchGlob[] = [];
  for (const { flag, value } of parsed.values) {
    if (flag === "--include")
      globs.push({ pattern: value, exclude: false, dialect: "grep" });
    else if (flag === "--exclude")
      globs.push({ pattern: value, exclude: true, dialect: "grep" });
    else if (flag === "--exclude-dir")
      globs.push({ pattern: value, exclude: true, dialect: "grep-dir" });
  }
  if (!globs.length) return undefined;
  return { globs, types: [], unmatched: globs[0]!.exclude ? "keep" : "drop" };
}

/** rg options that take a value, so the value is not mistaken for a path. */
const RG_VALUE = new Set([
  "-A",
  "-B",
  "-C",
  "-E",
  "-M",
  "-T",
  "-d",
  "-e",
  "-f",
  "-g",
  "-j",
  "-m",
  "-r",
  "-t",
  "--after-context",
  "--before-context",
  "--context",
  "--color",
  "--colors",
  "--dfa-size-limit",
  "--encoding",
  "--engine",
  "--file",
  "--glob",
  "--iglob",
  "--ignore-file",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--regex-size-limit",
  "--regexp",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-clear",
  "--type-not",
]);
const GREP_VALUE = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-d",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--context",
  "--binary-files",
  "--color",
  "--colour",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--file",
  "--group-separator",
  "--include",
  "--label",
  "--max-count",
  "--regexp",
]);
const DIFF_VALUE = new Set([
  "-C",
  "-D",
  "-F",
  "-I",
  "-L",
  "-S",
  "-U",
  "-W",
  "-X",
  "-x",
  "--context",
  "--unified",
  "--ifdef",
  "--show-function-line",
  "--ignore-matching-lines",
  "--label",
  "--starting-file",
  "--width",
  "--exclude",
  "--exclude-from",
  "--from-file",
  "--to-file",
  "--tabsize",
  "--color",
  "--palette",
  "--horizon-lines",
]);

interface Parsed {
  operands: string[];
  shortFlags: string;
  longFlags: string[];
  /** Every flag that took a value, in order, with the value it took. */
  values: Array<{ flag: string; value: string }>;
  /** The pattern came through `-e`/`--regexp`, so every operand is a path. */
  patternGiven: boolean;
}

/** Split a tool's words into flags and operands, knowing which flags take a value. */
function parseFlags(words: readonly string[], valueFlags: Set<string>): Parsed {
  const parsed: Parsed = {
    operands: [],
    shortFlags: "",
    longFlags: [],
    values: [],
    patternGiven: false,
  };
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") {
      parsed.operands.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = equals >= 0 ? word.slice(0, equals) : word;
      parsed.longFlags.push(name);
      if (name === "--regexp") parsed.patternGiven = true;
      if (valueFlags.has(name)) {
        const value = equals >= 0 ? word.slice(equals + 1) : (words[++index] ?? "");
        parsed.values.push({ flag: name, value });
      }
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const letter = word[at]!;
        parsed.shortFlags += letter;
        if (letter === "e") parsed.patternGiven = true;
        if (valueFlags.has(`-${letter}`)) {
          // The value is the rest of this word, or the next word.
          const value =
            at < word.length - 1 ? word.slice(at + 1) : (words[++index] ?? "");
          parsed.values.push({ flag: `-${letter}`, value });
          break;
        }
      }
      continue;
    }
    parsed.operands.push(word);
  }
  return parsed;
}

function directories(operands: readonly string[], cwd: string): string[] {
  return operands
    .map((operand) => resolve(cwd, operand))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * If the command (wrappers removed, `words[0]` the program) searches directories
 * recursively, which ones and how; otherwise null. Only content searches count —
 * `find`, `ls -R` and `tree` list names.
 */
export function recursiveReadOf(
  words: readonly string[],
  cwd: string,
): RecursiveRead | null {
  const program = words[0];
  if (program === "rg") {
    const parsed = parseFlags(words, RG_VALUE);
    if (
      parsed.longFlags.some((flag) =>
        ["--files", "--type-list", "--help", "--version"].includes(flag),
      )
    )
      return null;
    const paths = parsed.patternGiven ? parsed.operands : parsed.operands.slice(1);
    const unrestricted =
      (parsed.shortFlags.match(/u/g) ?? []).length +
      parsed.longFlags.filter((flag) => flag === "--unrestricted").length;
    return {
      dirs: paths.length ? directories(paths, cwd) : [cwd],
      hidden:
        parsed.longFlags.includes("--hidden") ||
        parsed.shortFlags.includes(".") ||
        unrestricted >= 2,
      follow: parsed.shortFlags.includes("L") || parsed.longFlags.includes("--follow"),
      respectsIgnore:
        unrestricted === 0 &&
        !parsed.longFlags.some((flag) => flag.startsWith("--no-ignore")),
      ...(rgFilter(parsed) ? { filter: rgFilter(parsed) } : {}),
    };
  }
  if (program === "grep") {
    const parsed = parseFlags(words, GREP_VALUE);
    const recursive =
      /[rR]/.test(parsed.shortFlags) ||
      parsed.longFlags.some(
        (flag) => flag === "--recursive" || flag === "--dereference-recursive",
      );
    if (!recursive) return null;
    const paths = parsed.patternGiven ? parsed.operands : parsed.operands.slice(1);
    return {
      dirs: paths.length ? directories(paths, cwd) : [cwd],
      hidden: true,
      follow:
        parsed.shortFlags.includes("R") ||
        parsed.longFlags.includes("--dereference-recursive"),
      respectsIgnore: false,
      ...(grepFilter(parsed) ? { filter: grepFilter(parsed) } : {}),
    };
  }
  if (program === "diff") {
    const parsed = parseFlags(words, DIFF_VALUE);
    if (!parsed.shortFlags.includes("r") && !parsed.longFlags.includes("--recursive"))
      return null;
    return {
      dirs: directories(parsed.operands, cwd),
      hidden: true,
      follow: true,
      respectsIgnore: false,
    };
  }
  return null;
}
