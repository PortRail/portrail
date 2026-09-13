import type { FastifyInstance } from "fastify";
import type { Decision, Operation } from "./types.ts";
import type { PortrailEvent } from "./store/index.ts";

export type {
  AgentId,
  CommandAction,
  Decision,
  DecisionScope,
  ExecOperation,
  FileChange,
  NetOperation,
  Operation,
  OperationKind,
  ReadOperation,
  RunState,
  ToolOperation,
  Verdict,
  WriteOperation,
  Workspace,
} from "./types.ts";
export type { PortrailEvent } from "./store/index.ts";

/** What a decider knows about the caller, beyond the operation itself. */
export interface DecisionContext {
  /** The API key that started this run, if any. */
  keyId: string | null;
  /** Rules attached to that key. A key may only narrow, never widen. */
  keyPolicy: unknown;
  workspaceRoot: string;
  /** Decisions already made in this run, so "allow for this run" can be honoured. */
  priorDecisions: ReadonlyArray<{ operation: Operation; decision: Decision }>;
}

/**
 * Answers the one question every provider asks. The built-in implementation is a
 * flat allow/deny list; Portrail Pro replaces it with a rule engine that can also
 * return `ask` and park the operation until a human decides.
 */
export interface Decider {
  readonly name: string;
  decide(operation: Operation, context: DecisionContext): Promise<Decision>;
}

/** Everything the host hands an extension at load time. */
export interface ExtensionHost {
  version: string;
  dataDir: string;
  /** The record store, so an extension can persist its own kinds. */
  store: import("./store/index.ts").Store;
  /** The engine itself, for extensions that drive it (relay mode creates runs). */
  gateway: import("./core/gateway.ts").Gateway;
  /** Flags from the command line the core does not interpret, e.g. --relay. */
  options: Record<string, string | boolean>;
  /** Resolve a parked operation. Throws if the operation is gone or already decided. */
  resolve(operationId: string, decision: Decision, actor: string): void;
}

export interface ExtensionCommand {
  description: string;
  run(args: { positional: string[]; flags: Map<string, string | boolean>; dataDir: string }): Promise<number>;
}

export interface Extension {
  readonly name: string;
  readonly version: string;
  /** Replaces the built-in allow/deny decider. Return null to leave the built-in one in place. */
  decider?(host: ExtensionHost): Decider | null;
  /** One line for /health and `portrail doctor`: is the extension active, and why or why not. */
  status?(dataDir: string): { active: boolean; detail: string };
  /** Mounts additional routes, e.g. /v1/policy, /v1/approvals, /v1/audit, /v1/fleet. */
  routes?(app: FastifyInstance, host: ExtensionHost): void | Promise<void>;
  /** Every durable event, after commit. Feeds audit logs and webhooks. */
  onEvent?(event: PortrailEvent): void;
  /** Called once the daemon is listening. Relay mode starts its outbound loop here. */
  start?(host: ExtensionHost, listening: { url: string }): Promise<void> | void;
  /** Extra CLI subcommands, e.g. `portrail relay`. */
  commands?: Record<string, ExtensionCommand>;
  /** Called once during shutdown. */
  close?(): Promise<void> | void;
}

export const EXTENSION_MODULE = "@portrail/pro";

/** Re-exported so an extension can reuse the core's own helpers rather than copy them. */
export { PortrailError, ensure, fail } from "./contracts/errors.ts";
export { digest, id as newId, now, secret, canonical, equal } from "./store/index.ts";
export { globToRegExp } from "./decide/match.ts";
export { sedObjection } from "./decide/sed.ts";
export { canonicalPath } from "./core/gateway.ts";
export { reachableFiles, REACH_LIMIT } from "./core/reach.ts";
export type { RunRecord, SessionRecord, OperationRecord } from "./core/records.ts";
export type { KeyRecord, Principal, Scope } from "./core/keys.ts";
export { Keys } from "./core/keys.ts";
