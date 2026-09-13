import { statSync } from "node:fs";
import { resolve } from "node:path";

/** What a recursive search in a command can reach, and how the tool walks. */
export interface RecursiveRead {
  dirs: string[];
  /** The tool reads dotfiles. */
  hidden: boolean;
  /** The tool follows symlinks it meets while walking. */
  follow: boolean;
  /** The tool skips what .gitignore names. */
  respectsIgnore: boolean;
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
  /** The pattern came through `-e`/`--regexp`, so every operand is a path. */
  patternGiven: boolean;
}

/** Split a tool's words into flags and operands, knowing which flags take a value. */
function parseFlags(words: readonly string[], valueFlags: Set<string>): Parsed {
  const parsed: Parsed = {
    operands: [],
    shortFlags: "",
    longFlags: [],
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
      if (equals < 0 && valueFlags.has(name)) index++;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const letter = word[at]!;
        parsed.shortFlags += letter;
        if (letter === "e") parsed.patternGiven = true;
        if (valueFlags.has(`-${letter}`)) {
          // The value is the rest of this word, or the next word.
          if (at === word.length - 1) index++;
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
