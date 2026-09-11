import type { AgentId, Decision, Operation, RunState } from "../types.ts";

export interface SessionRecord {
  id: string;
  workspaceId: string;
  agent: AgentId;
  state: "open" | "closed" | "attention_required";
  /** The provider's own conversation id, once known. Needed to resume. */
  nativeSessionId: string | null;
  lastEventSeq: number;
  createdAt: string;
  lastActivityAt: string;
  keyId: string | null;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  prompt: string;
  state: RunState;
  model: string | null;
  keyId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  deadlineAt: string;
  /** Final text the agent produced, or the failure reason. */
  summary: string | null;
  /** Set when a cancel was requested; the final state may still be succeeded. */
  cancellationRequested: boolean;
  /** Identifies which in-process worker owns this run. Stale workers cannot act. */
  workerEpoch: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** What the agent asked for and what it got. A succeeded run with denials is not a clean success. */
  operations: { total: number; allowed: number; denied: number; asked: number };
  operationIds: string[];
  /** Caller-supplied fields the core carries but does not act on, e.g. Pro's callback. */
  metadata: Record<string, unknown>;
}

export interface OperationRecord {
  id: string;
  sessionId: string;
  runId: string;
  operation: Operation;
  state: "deciding" | "pending" | "decided" | "expired";
  decision: Decision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** For parked operations: when a missing decision becomes a refusal. */
  expiresAt: string | null;
}
