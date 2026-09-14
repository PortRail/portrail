import type { Decider, DecisionContext } from "../extension.ts";
import type { Decision, Operation } from "../types.ts";
import { parsePatterns, type Pattern } from "./match.ts";
import { REACH_LIMIT } from "../core/reach.ts";
import { analyseOperation, type OperationAnalysis } from "./analysis.ts";

export { parseCommand, type CommandSegment } from "./command.ts";

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

function subjects(analysis: OperationAnalysis): Subject[] {
  switch (analysis.kind) {
    case "read":
    case "write":
      return analysis.paths.map(plain);
    case "exec":
      return analysis.segments.map((segment) => ({
        deny: segment.denyForms,
        allow: segment.allowForms,
      }));
    case "net":
    case "tool":
      return [plain(analysis.subject ?? "*")];
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

function firstDenied(
  patterns: readonly Pattern[],
  kind: string,
  subjects: readonly Subject[],
): Pattern | undefined {
  return firstMatch(
    patterns,
    kind,
    subjects.flatMap((subject) => subject.deny),
  );
}

function firstAllowed(
  patterns: readonly Pattern[],
  kind: string,
  subjects: readonly Subject[],
): Pattern | undefined {
  return firstMatch(
    patterns,
    kind,
    subjects.flatMap((subject) => subject.allow),
  );
}

function everySubjectMatches(
  patterns: readonly Pattern[],
  kind: string,
  subjects: readonly Subject[],
): boolean {
  return subjects.every((subject) =>
    subject.allow.some((value) =>
      patterns.some((pattern) => pattern.kind === kind && pattern.test(value)),
    ),
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
    lists: {
      allow: readonly string[];
      deny: readonly string[];
      ask?: readonly string[];
    },
    options: { reachLimit?: number } = {},
  ) {
    this.allow = parsePatterns(lists.allow);
    this.deny = parsePatterns(lists.deny);
    this.ask = parsePatterns(lists.ask ?? []);
    this.reachLimit = options.reachLimit ?? REACH_LIMIT;
  }

  async decide(operation: Operation, context: DecisionContext): Promise<Decision> {
    const analysis = await analyseOperation(operation, {
      workspaceRoot: context.workspaceRoot,
      reachLimit: this.reachLimit,
      suspect: (path) => !!firstMatch(this.deny, "read", [path]),
    });

    if (analysis.unjudgeable)
      return {
        verdict: "deny",
        reason: `Refused: the command uses ${analysis.unjudgeable}, which cannot be judged by a rule. Run it as separate plain commands.`,
      };

    const values = subjects(analysis);

    // An operation that declares nothing cannot be judged, and [].every() is true.
    if (values.length === 0) {
      if (operation.kind === "read") values.push(plain("."));
      else
        return {
          verdict: "deny",
          reason: `Refused: a ${operation.kind} operation with nothing declared.`,
        };
    }

    // A search over a directory is judged by every file it can reach. A reached file
    // the deny list names refuses the search; for a read, everything reached joins the
    // subjects, so the allow list must cover it too.
    for (const search of analysis.searches) {
      if (search.refused) return { verdict: "deny", reason: search.refused };
      const rule = firstMatch(this.deny, "read", search.files);
      if (rule) {
        const file = search.files.find((path) => rule.test(path));
        return {
          verdict: "deny",
          reason: `Refused by the deny list (${rule.source}): a search over ${search.where} reaches ${file}. Search a narrower path.`,
          rule: rule.source,
        };
      }
      if (operation.kind === "read" && search.files.length) {
        // The search reads the files, not the directory entry: the allow list must cover those.
        const own = values.findIndex((subject) => subject.allow[0] === search.where);
        if (own >= 0) values.splice(own, 1);
        values.push(...search.files.map(plain));
      }
    }

    // A command that names a file reads it, whatever the file is called on the line.
    if (analysis.namedPaths.length) {
      const denied = firstMatch(this.deny, "read", analysis.namedPaths);
      if (denied)
        return {
          verdict: "deny",
          reason: `Refused by the deny list (${denied.source}): the command reads ${analysis.namedPaths.find((path) => denied.test(path))}.`,
          rule: denied.source,
        };
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
    for (const segment of analysis.segments)
      if (segment.sedObjection)
        return {
          verdict: "deny",
          reason: `Refused: only sed scripts that print or filter are allowed (${segment.sedObjection}). Use -n or -E with p, d, s/…/…/ and addresses; w, r, e, -i and -f cannot be judged by a rule.`,
        };

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
    if (
      this.ask.length &&
      everySubjectMatches([...this.allow, ...this.ask], operation.kind, values)
    ) {
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
