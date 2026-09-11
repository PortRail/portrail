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
}

export interface WriteOperation extends OperationBase {
  kind: "write";
  changes: FileChange[];
}

export interface ReadOperation extends OperationBase {
  kind: "read";
  paths: string[];
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
