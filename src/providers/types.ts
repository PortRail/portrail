import type { AgentId, Decision, FileChange, Operation, Workspace } from "../types.ts";

export interface ProviderStatus {
  id: AgentId;
  installed: boolean;
  /** Installed AND signed in AND a version we can talk to. */
  ready: boolean;
  version: string | null;
  authMode: "subscription" | "api_key" | "none" | "unknown";
  /** One sentence a human can act on when `ready` is false. */
  detail: string;
  /** False when `ready` was inferred from credentials on disk rather than a real call. */
  verified?: boolean;
  models?: Array<{ id: string; displayName: string }>;
}

/** Normalised stream every provider emits, whatever its native protocol looks like. */
export type ProviderEvent =
  | { type: "started"; nativeSessionId: string | null }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "command.started"; opId: string; command: string; cwd: string }
  | { type: "command.output"; opId: string; text: string }
  | { type: "command.finished"; opId: string; exitCode: number | null }
  | { type: "files.changed"; changes: FileChange[] }
  | { type: "diff"; unified: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    }
  | { type: "warning"; message: string };

export type RunOutcome = {
  /**
   * `outcome_unknown`: the agent had the work and the provider lost contact before it
   * reported back. The work may be half done; nothing is replayed.
   */
  state: "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  summary: string;
};

export interface RunContext {
  sessionId: string;
  runId: string;
  workspace: Workspace;
  prompt: string;
  /** The provider's own session id, when resuming an earlier conversation. */
  nativeSessionId?: string | undefined;
  model?: string | undefined;
  maxSeconds: number;
  signal: AbortSignal;
  /** The single question every provider asks. Blocks while a human decides. */
  decide(operation: Operation): Promise<Decision>;
  emit(event: ProviderEvent): void;
}

export interface ProviderHandle {
  /** Available once `started` has fired; needed to resume later. */
  nativeSessionId(): string | null;
  interrupt(): Promise<void>;
  steer(text: string): Promise<void>;
  /** Stop the worker. Safe to call twice. */
  close(force?: boolean): void;
  /** Resolves when the agent has finished, one way or another. */
  done: Promise<RunOutcome>;
}

export interface ProbeOptions {
  /** Really talk to the agent (may cost inference). Off for anything periodic. */
  deep?: boolean;
}

export interface Provider {
  readonly id: AgentId;
  probe(options?: ProbeOptions): Promise<ProviderStatus>;
  start(context: RunContext): Promise<ProviderHandle>;
}
