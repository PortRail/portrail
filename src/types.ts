/** The agents Portrail can drive. */
export type AgentId = "codex" | "claude" | "fake";

/** Every action an agent asks permission for, normalised across providers. */
export type OperationKind = "read" | "write" | "exec" | "net" | "tool";

export interface FileChange {
  path: string;
  /** Unified diff when the provider supplies one. */
  diff?: string;
  change: "add" | "update" | "delete";
}

/** Codex's best-effort classification of what a command is really doing. */
export type CommandAction =
  | { action: "read"; path?: string }
  | { action: "list"; path?: string }
  | { action: "search"; path?: string; query?: string }
  | { action: "unknown" };

interface OperationBase {
  id: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  agent: AgentId;
  requestedAt: string;
  /** What the agent says it needs this for, when it says anything. */
  reason?: string;
}

export interface ExecOperation extends OperationBase {
  kind: "exec";
  /** Display form, and what command rules match against. */
  command: string;
  /** The exact argv when the provider gives us one — never re-parsed from a string. */
  argv?: string[];
  cwd: string;
  actions?: CommandAction[];
  /**
   * Canonical paths of the files and directories the command names, filled in by
   * containment. A rule can judge them as reads; a word that names nothing on disk
   * is not here.
   */
  paths?: string[];
}

export interface WriteOperation extends OperationBase {
  kind: "write";
  changes: FileChange[];
}

/** One include or exclude pattern a search tool was given, in the order it was given. */
export interface SearchGlob {
  pattern: string;
  /** A leading `!` (rg) or `--exclude` (grep): files this matches are not opened. */
  exclude: boolean;
  /**
   * How the tool reads the pattern. rg: a glob without a slash matches a name at any
   * depth, one with a slash is anchored to the working directory, braces expand.
   * grep: a shell glob against the base name. grep-dir: `--exclude-dir`, directories only.
   */
  dialect: "rg" | "grep" | "grep-dir";
  /** `--iglob`: the tool itself matches without regard to case. */
  ignoreCase?: boolean;
}

/** What a search was told to open; files it would never open are not held against it. */
export interface SearchFilter {
  globs: SearchGlob[];
  /** `-t`/`--type` names, narrowing to the tool's own extension lists; unknown names narrow nothing. */
  types: string[];
  /** What happens to a file no glob matches: rg drops it once any include glob exists, else keeps it. */
  unmatched: "keep" | "drop";
}

export interface ReadOperation extends OperationBase {
  kind: "read";
  paths: string[];
  /** A search over a directory: every file beneath it may be read, so every file is judged. */
  recursive?: boolean;
  /** For a search: the filters it was given, so only files it would open are judged. */
  filter?: SearchFilter;
}

export interface NetOperation extends OperationBase {
  kind: "net";
  host?: string;
  url?: string;
  protocol?: string;
}

export interface ToolOperation extends OperationBase {
  kind: "tool";
  server: string;
  tool: string;
  input: Record<string, unknown>;
}

export type Operation =
  | ExecOperation
  | WriteOperation
  | ReadOperation
  | NetOperation
  | ToolOperation;

export type Verdict = "allow" | "deny" | "ask";

/** How long an allow lasts. Providers that support it are told; others re-ask. */
export type DecisionScope = "once" | "run" | "session";

export interface Decision {
  verdict: Verdict;
  /** Always populated — this is what a human or an audit log reads. */
  reason: string;
  /** Identifies the rule that produced the verdict, when a rule engine is loaded. */
  rule?: string;
  scope?: DecisionScope;
}

export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

/** Between queued and terminal: a worker owns the run. Kept in step with RunState. */
export const IN_FLIGHT_STATES: readonly RunState[] = [
  "starting",
  "running",
  "waiting_for_approval",
  "cancelling",
];
/** Anything that is not over yet, queued included. */
export const ACTIVE_STATES: readonly RunState[] = ["queued", ...IN_FLIGHT_STATES];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

export interface Workspace {
  id: string;
  name: string;
  root: string;
  createdAt: string;
}
