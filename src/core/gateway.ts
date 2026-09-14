import { EventEmitter } from "node:events";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensure, fail, isPortrailError } from "../contracts/errors.ts";
import type { Decider, DecisionContext } from "../extension.ts";
import type { Provider, ProviderEvent, ProviderHandle } from "../providers/types.ts";
import { Store, id as newId, now, type PortrailEvent } from "../store/index.ts";
import {
  TERMINAL_STATES,
  type AgentId,
  type Decision,
  type Operation,
  type RunState,
  type Workspace,
  ACTIVE_STATES,
  IN_FLIGHT_STATES,
} from "../types.ts";
import { parseCommand, type CommandSegment } from "../decide/builtin.ts";
import { PROTECTED_HOME_ENTRIES } from "./protected.ts";
import { RUN_MAX_SECONDS } from "../config.ts";
import { canonicalPath, isWithin, isWithinFold } from "./paths.ts";
export { canonicalPath } from "./paths.ts";
import { DeltaBatcher } from "./delta-batcher.ts";
import { ParkingLot } from "./parking.ts";
import type { OperationRecord, RunRecord, SessionRecord } from "./records.ts";

export interface GatewayOptions {
  /** Portrail's own data directory. Never enrollable, never writable by an agent. */
  dataDir?: string;
  maxConcurrent: number;
  defaultMaxSeconds: number;
  /** How long a parked operation may wait before it is refused. */
  approvalTimeoutMs: number;
  /** Total pending runs the queue will hold before refusing new ones. */
  maxQueued: number;
}

export interface CreateRunInput {
  /** Caller-assigned id, so a relay and its machine agree on it. Must be unique. */
  id?: string;
  sessionId?: string;
  workspace?: string;
  agent?: AgentId;
  prompt: string;
  model?: string;
  maxSeconds?: number;
  keyId?: string | null;
  metadata?: Record<string, unknown>;
}

/** What one retention pass removed, and the moment before which things were considered old. */
export interface RetentionResult {
  cutoff: string;
  sessions: number;
  runs: number;
  operations: number;
  events: number;
  commands: number;
}

/** The answer to any question asked on behalf of a run that is over. */
const NOT_ACTIVE: Decision = {
  verdict: "deny",
  reason: "The run is no longer active.",
};

interface Worker {
  epoch: string;
  abort: AbortController;
  handle: ProviderHandle | null;
  /**
   * What the decider may build on: session-scoped allows from earlier runs of the
   * session, then every decision of this run as it is made. Kept here so a permission
   * question does not re-read the session's whole history.
   */
  decisions: Array<{ operation: Operation; decision: Decision }>;
}

/**
 * The engine. Owns every session and run, dispatches work to providers, answers
 * their permission questions, and writes the durable event log that clients
 * stream from.
 *
 * Two invariants hold everywhere in this file:
 *  - A run that was handed to an agent and whose outcome we cannot confirm ends
 *    as `outcome_unknown`, never as a guess. Restarts do not replay it.
 *  - A provider's permission question is answered from exactly one place,
 *    `decide()`, and the workspace boundary is checked there before any rule runs.
 */
export class Gateway extends EventEmitter {
  private workers = new Map<string, Worker>();
  private tasks = new Set<Promise<void>>();
  private pumping = false;
  private closing = false;
  readonly parking = new ParkingLot();

  constructor(
    readonly store: Store,
    readonly providers: ReadonlyMap<AgentId, Provider>,
    private decider: Decider,
    readonly options: GatewayOptions,
  ) {
    super();
    // Deliberately no recover() here. A Gateway is also constructed by offline CLI
    // commands on the daemon's live database; recovering from there would mark the
    // daemon's in-flight runs unknown. Only the daemon that owns the runs recovers.
  }

  /** Swap the decider at runtime — how an extension takes over. */
  useDecider(decider: Decider) {
    this.decider = decider;
  }

  // ---------------------------------------------------------------- events

  private emitEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown> = {},
    runId?: string,
  ): PortrailEvent {
    const event = this.store.event(sessionId, type, data, runId);
    this.store.afterCommit(() => this.emit("event", event));
    return event;
  }

  // ------------------------------------------------------------ recovery

  /**
   * Called once at startup by the process that owns the runs. Anything that was
   * mid-flight when the previous process died cannot be trusted: the agent may have
   * run the command, or not. Anything still queued never started, so it is ours to run.
   */
  recover() {
    this.store.tx(() => {
      for (const run of this.store.select<RunRecord>("run", {
        state: IN_FLIGHT_STATES,
      }))
        this.finish(
          run.id,
          "outcome_unknown",
          "Portrail restarted while this run was in progress. The agent may have completed part of the work; nothing was replayed.",
        );
      for (const operation of this.store.select<OperationRecord>("operation", {
        state: ["pending", "deciding"],
      }))
        this.store.put("operation", { ...operation, state: "expired" });
      this.store.afterCommit(() => void this.pump());
    });
  }

  // ----------------------------------------------------------- workspaces

  addWorkspace(input: { name: string; root: string }): Workspace {
    ensure(
      typeof input.name === "string" && /^[a-z0-9][a-z0-9-_]{0,63}$/i.test(input.name),
      400,
      "INVALID_REQUEST",
      "Workspace name must be 1–64 letters, digits, dashes or underscores.",
    );
    ensure(
      typeof input.root === "string" && isAbsolute(input.root),
      400,
      "INVALID_REQUEST",
      "Workspace root must be an absolute path.",
    );
    let canonical: string;
    try {
      canonical = realpathSync.native(input.root);
      ensure(
        statSync(canonical).isDirectory(),
        400,
        "INVALID_REQUEST",
        "Choose a directory.",
      );
    } catch (error) {
      if (isPortrailError(error)) throw error;
      fail(400, "INVALID_REQUEST", `Workspace directory does not exist: ${input.root}`);
    }
    const refused = refuseWorkspaceRoot(canonical, this.options.dataDir);
    ensure(!refused, 400, "INVALID_REQUEST", refused ?? "");
    return this.store.tx(() => {
      const existing = this.store
        .list<Workspace>("workspace")
        .find(
          (workspace) => workspace.name === input.name || workspace.root === canonical,
        );
      ensure(
        !existing,
        409,
        "ALREADY_EXISTS",
        existing?.name === input.name
          ? `A workspace named "${input.name}" already exists.`
          : `${canonical} is already enrolled as "${existing?.name}".`,
      );
      return this.store.put<Workspace>("workspace", {
        id: newId("ws"),
        name: input.name,
        root: canonical,
        createdAt: now(),
      });
    });
  }

  listWorkspaces(): Workspace[] {
    return this.store.list<Workspace>("workspace");
  }

  workspace(ref: string): Workspace {
    const found = this.store
      .list<Workspace>("workspace")
      .find((workspace) => workspace.id === ref || workspace.name === ref);
    ensure(
      found,
      404,
      "NOT_FOUND",
      `No workspace named "${ref}". Add one with \`portrail workspace add\`.`,
    );
    return found;
  }

  removeWorkspace(ref: string) {
    const workspace = this.workspace(ref);
    const active = this.store
      .select<SessionRecord>("session", { state: "open" })
      .filter((session) => session.workspaceId === workspace.id)
      .some(
        (session) =>
          this.store.count("run", { sessionId: session.id, state: ACTIVE_STATES }) > 0,
      );
    ensure(
      !active,
      409,
      "BUSY",
      "A run is active in this workspace. Wait or cancel it first.",
    );
    this.store.remove("workspace", workspace.id);
  }

  // ------------------------------------------------------------- sessions

  createSession(input: {
    workspace: string;
    agent: AgentId;
    keyId?: string | null;
  }): SessionRecord {
    const workspace = this.workspace(input.workspace);
    ensure(
      this.providers.has(input.agent),
      422,
      "AGENT_UNAVAILABLE",
      `Agent "${input.agent}" is not available. Run \`portrail doctor\`.`,
    );
    return this.store.tx(() => {
      const session = this.store.put<SessionRecord>("session", {
        id: newId("ses"),
        workspaceId: workspace.id,
        agent: input.agent,
        state: "open",
        nativeSessionId: null,
        lastEventSeq: 0,
        createdAt: now(),
        lastActivityAt: now(),
        keyId: input.keyId ?? null,
      });
      this.emitEvent(session.id, "session.created", {
        workspace: workspace.name,
        agent: input.agent,
      });
      return this.store.get<SessionRecord>("session", session.id)!;
    });
  }

  session(sessionId: string): SessionRecord {
    const session = this.store.get<SessionRecord>("session", sessionId);
    ensure(session, 404, "NOT_FOUND", "Session not found.");
    return session;
  }

  listSessions(): SessionRecord[] {
    return this.store.select<SessionRecord>("session", { newestFirst: true });
  }

  /** One page of sessions, newest first, with the total. */
  pageSessions(
    limit: number,
    offset: number,
  ): { items: SessionRecord[]; total: number } {
    return this.store.page<SessionRecord>("session", {}, limit, offset);
  }

  closeSession(sessionId: string): SessionRecord {
    return this.store.tx(() => {
      const session = this.session(sessionId);
      if (session.state === "closed") return session;
      const active = this.store.count("run", { sessionId, state: ACTIVE_STATES }) > 0;
      ensure(!active, 409, "BUSY", "Cancel the active run before closing the session.");
      this.store.put("session", { ...session, state: "closed" });
      this.emitEvent(sessionId, "session.closed");
      return this.session(sessionId);
    });
  }

  // ----------------------------------------------------------------- runs

  createRun(input: CreateRunInput): RunRecord {
    ensure(!this.closing, 503, "SHUTTING_DOWN", "Portrail is shutting down.");
    ensure(
      typeof input.prompt === "string" && input.prompt.trim().length > 0,
      400,
      "INVALID_REQUEST",
      "A prompt is required.",
    );
    ensure(
      Buffer.byteLength(input.prompt) <= 256 * 1024,
      413,
      "PAYLOAD_TOO_LARGE",
      "The prompt exceeds 256 KiB.",
    );

    return this.store.tx(() => {
      let session: SessionRecord;
      if (input.sessionId) {
        session = this.session(input.sessionId);
        ensure(
          session.state === "open",
          409,
          "SESSION_CLOSED",
          session.state === "attention_required"
            ? "This session needs attention: its last run has an unknown outcome. Start a new session."
            : "This session is closed.",
        );
      } else {
        ensure(
          input.workspace,
          400,
          "INVALID_REQUEST",
          "Give a workspace or a session.",
        );
        ensure(input.agent, 400, "INVALID_REQUEST", "Give an agent (codex or claude).");
        session = this.createSession({
          workspace: input.workspace,
          agent: input.agent,
          keyId: input.keyId ?? null,
        });
      }

      const active =
        this.store.count("run", { sessionId: session.id, state: ACTIVE_STATES }) > 0;
      ensure(!active, 409, "BUSY", "This session already has a run in progress.");

      ensure(
        this.store.count("run", { state: "queued" }) < this.options.maxQueued,
        429,
        "QUEUE_FULL",
        "Too many runs are waiting. Try again shortly.",
      );

      const maxSeconds = input.maxSeconds ?? this.options.defaultMaxSeconds;
      ensure(
        Number.isInteger(maxSeconds) &&
          maxSeconds >= RUN_MAX_SECONDS.min &&
          maxSeconds <= RUN_MAX_SECONDS.max,
        400,
        "INVALID_REQUEST",
        `maxSeconds must be between ${RUN_MAX_SECONDS.min} and ${RUN_MAX_SECONDS.max}.`,
      );

      if (input.id) {
        ensure(
          /^run_[A-Za-z0-9-]{8,80}$/.test(input.id),
          400,
          "INVALID_REQUEST",
          "A run id must look like run_….",
        );
        ensure(
          !this.store.get("run", input.id),
          409,
          "ALREADY_EXISTS",
          "A run with that id already exists.",
        );
      }
      const created = Date.now();
      const run = this.store.put<RunRecord>("run", {
        id: input.id ?? newId("run"),
        sessionId: session.id,
        prompt: input.prompt,
        state: "queued",
        model: input.model ?? null,
        keyId: input.keyId ?? session.keyId,
        createdAt: new Date(created).toISOString(),
        startedAt: null,
        completedAt: null,
        deadlineAt: new Date(created + maxSeconds * 1000).toISOString(),
        summary: null,
        cancellationRequested: false,
        workerEpoch: null,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
        operations: { total: 0, allowed: 0, denied: 0, asked: 0 },
        operationIds: [],
        metadata: input.metadata ?? {},
      });
      this.emitEvent(
        session.id,
        "run.queued",
        { runId: run.id, metadata: run.metadata },
        run.id,
      );
      this.store.afterCommit(() => void this.pump());
      return run;
    });
  }

  run(runId: string): RunRecord {
    const run = this.store.get<RunRecord>("run", runId);
    ensure(run, 404, "NOT_FOUND", "Run not found.");
    return run;
  }

  listRuns(sessionId?: string): RunRecord[] {
    return this.store.select<RunRecord>("run", { sessionId, newestFirst: true });
  }

  /** One page of runs, newest first, filtered in the database, with the total. */
  pageRuns(
    filter: { sessionId?: string; state?: RunState },
    limit: number,
    offset: number,
  ): { items: RunRecord[]; total: number } {
    return this.store.page<RunRecord>("run", filter, limit, offset);
  }

  private setState(runId: string, state: RunState) {
    this.store.tx(() => {
      const run = this.store.get<RunRecord>("run", runId);
      if (!run || TERMINAL_STATES.has(run.state) || run.state === state) return;
      this.store.put("run", { ...run, state });
      this.emitEvent(run.sessionId, "run.state_changed", { state }, runId);
    });
  }

  private finish(runId: string, state: RunState, summary: string) {
    this.store.tx(() => {
      const run = this.store.get<RunRecord>("run", runId);
      if (!run || TERMINAL_STATES.has(run.state)) return;
      this.store.put("run", {
        ...run,
        state,
        summary: summary.slice(0, 64 * 1024),
        completedAt: now(),
      });
      if (state === "outcome_unknown") {
        const session = this.store.get<SessionRecord>("session", run.sessionId);
        if (session)
          this.store.put("session", { ...session, state: "attention_required" });
      }
      this.emitEvent(
        run.sessionId,
        "run.completed",
        {
          state,
          summary: summary.slice(0, 64 * 1024),
          cancellationRace: run.cancellationRequested && state === "succeeded",
        },
        runId,
      );
      this.parking.drain("The run ended before a decision arrived.", (operationId) =>
        this.belongsTo(operationId, runId),
      );
    });
  }

  // ------------------------------------------------------------- dispatch

  private async pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (const run of this.store.select<RunRecord>("run", { state: "queued" })) {
        if (this.workers.size >= this.options.maxConcurrent) break;
        const session = this.store.get<SessionRecord>("session", run.sessionId);
        if (!session || session.state !== "open") {
          this.finish(
            run.id,
            "cancelled",
            "The session closed before the run started.",
          );
          continue;
        }
        const worker: Worker = {
          decisions: [],
          epoch: newId("wrk"),
          abort: new AbortController(),
          handle: null,
        };
        this.workers.set(run.id, worker);
        const task = this.execute(run, session, worker)
          .catch((error: Error) =>
            this.finish(run.id, "failed", error.message ?? "The run failed."),
          )
          .finally(() => {
            this.workers.delete(run.id);
            this.tasks.delete(task);
            void this.pump();
          });
        this.tasks.add(task);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(run: RunRecord, session: SessionRecord, worker: Worker) {
    const provider = this.providers.get(session.agent);
    if (!provider) {
      this.finish(run.id, "failed", `Agent "${session.agent}" is not available.`);
      return;
    }
    const workspace = this.store.get<Workspace>("workspace", session.workspaceId);
    if (!workspace) {
      this.finish(run.id, "failed", "The workspace was removed.");
      return;
    }

    this.store.tx(() => {
      this.store.put("run", {
        ...this.run(run.id),
        workerEpoch: worker.epoch,
        startedAt: now(),
      });
      this.setState(run.id, "starting");
    });

    let handedToAgent = false;
    let output = "";
    const batcher = new DeltaBatcher(
      (text) => {
        if (!TERMINAL_STATES.has(this.run(run.id).state))
          this.emitEvent(session.id, "output.text", { text }, run.id);
      },
      () => this.finish(run.id, "failed", "Storage failed while streaming output."),
    );

    const deadline = setTimeout(
      () => void this.cancel(run.id, "The run reached its time limit."),
      Math.max(1, Date.parse(run.deadlineAt) - Date.now()),
    );
    deadline.unref();

    const onEvent = (event: ProviderEvent) => {
      if (TERMINAL_STATES.has(this.run(run.id).state)) return;
      switch (event.type) {
        case "started":
          handedToAgent = true;
          if (event.nativeSessionId)
            this.store.put("session", {
              ...this.session(session.id),
              nativeSessionId: event.nativeSessionId,
            });
          this.setState(run.id, "running");
          this.emitEvent(session.id, "run.started", {}, run.id);
          return;
        case "text":
          output = (output + event.text).slice(-64 * 1024);
          batcher.append(event.text);
          return;
        case "reasoning":
          this.emitEvent(session.id, "output.reasoning", { text: event.text }, run.id);
          return;
        case "command.started":
        case "command.output":
        case "command.finished":
        case "files.changed":
        case "diff":
        case "warning": {
          const { type, ...data } = event;
          this.emitEvent(session.id, type, data as Record<string, unknown>, run.id);
          return;
        }
        case "usage": {
          const current = this.run(run.id);
          this.store.put("run", {
            ...current,
            usage: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              costUsd: event.costUsd ?? current.usage.costUsd,
            },
          });
          this.emitEvent(
            session.id,
            "usage",
            {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            },
            run.id,
          );
          return;
        }
      }
    };

    // Anything an earlier run of this session allowed "for the session" still carries.
    worker.decisions = this.store
      .select<OperationRecord>("operation", { sessionId: session.id, state: "decided" })
      .filter((op) => op.decision?.scope === "session")
      .map((op) => ({ operation: op.operation, decision: op.decision! }));
    try {
      const handle = await provider.start({
        sessionId: session.id,
        runId: run.id,
        workspace,
        prompt: run.prompt,
        nativeSessionId: session.nativeSessionId ?? undefined,
        model: run.model ?? undefined,
        maxSeconds: Math.round((Date.parse(run.deadlineAt) - Date.now()) / 1000),
        signal: worker.abort.signal,
        decide: (operation) => this.decide(run.id, worker, operation, workspace),
        emit: onEvent,
      });
      worker.handle = handle;
      if (worker.abort.signal.aborted) {
        handle.close();
        this.finish(run.id, "cancelled", "Cancelled before the agent started.");
        return;
      }
      const outcome = await handle.done;
      batcher.flush();
      // When the provider lost the agent, its account of that is the summary: partial
      // output would read like a result.
      this.finish(
        run.id,
        outcome.state,
        outcome.state === "outcome_unknown"
          ? outcome.summary
          : output.trim() || outcome.summary,
      );
    } catch (error) {
      batcher.flush();
      const message = (error as Error).message ?? "The agent failed.";
      // If the agent had the work and we lost track of it, we do not know what
      // happened. If it never started, we do.
      this.finish(
        run.id,
        handedToAgent && !worker.abort.signal.aborted
          ? "outcome_unknown"
          : worker.abort.signal.aborted
            ? "cancelled"
            : "failed",
        message,
      );
    } finally {
      clearTimeout(deadline);
      batcher.dispose();
      worker.handle?.close();
      this.store.tx(() => {
        for (const operation of this.store.select<OperationRecord>("operation", {
          runId: run.id,
          state: ["pending", "deciding"],
        }))
          this.store.put("operation", { ...operation, state: "expired" });
      });
    }
  }

  // ------------------------------------------------------------ decisions

  /** True once this worker may no longer act for the run: over, cancelling, superseded or aborted. */
  private inactive(runId: string, workerEpoch: string): boolean {
    const run = this.store.get<RunRecord>("run", runId);
    const worker = this.workers.get(runId);
    return (
      !run ||
      run.workerEpoch !== workerEpoch ||
      TERMINAL_STATES.has(run.state) ||
      run.state === "cancelling" ||
      worker?.abort.signal.aborted === true
    );
  }

  /** Looked up at drain time, so an operation registered a moment ago is drained too. */
  private belongsTo(operationId: string, runId: string): boolean {
    return this.store.get<OperationRecord>("operation", operationId)?.runId === runId;
  }

  /**
   * The single place a provider's "may I?" is answered.
   *
   * Order matters: the workspace boundary is checked first and is not something a
   * decider can override. Then the decider runs. If it says `ask`, the operation
   * parks until an extension resolves it or the deadline refuses it.
   */
  private async decide(
    runId: string,
    worker: Worker,
    operation: Operation,
    workspace: Workspace,
  ): Promise<Decision> {
    if (this.inactive(runId, worker.epoch)) return NOT_ACTIVE;
    const run = this.run(runId);

    const record: OperationRecord = {
      id: operation.id,
      sessionId: run.sessionId,
      runId,
      operation,
      state: "deciding",
      decision: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: now(),
      expiresAt: null,
    };
    this.store.tx(() => {
      this.store.put("operation", record);
      this.store.put("run", {
        ...this.run(runId),
        operationIds: [...run.operationIds, operation.id],
      });
      this.emitEvent(run.sessionId, "operation.requested", { operation }, runId);
    });

    const settle = (decision: Decision, decidedBy: string): Decision => {
      let recorded = false;
      this.store.tx(() => {
        const current = this.store.get<OperationRecord>("operation", operation.id);
        if (!current || current.state === "decided") return;
        recorded = true;
        const latest = this.run(runId);
        const counts = {
          ...(latest.operations ?? { total: 0, allowed: 0, denied: 0, asked: 0 }),
        };
        counts.total += 1;
        if (decision.verdict === "allow") counts.allowed += 1;
        else counts.denied += 1;
        this.store.put("run", { ...latest, operations: counts });
        this.store.put("operation", {
          ...current,
          state: "decided",
          decision,
          decidedBy,
          decidedAt: now(),
        });
        this.emitEvent(
          run.sessionId,
          "operation.decided",
          {
            operationId: operation.id,
            verdict: decision.verdict,
            reason: decision.reason,
            rule: decision.rule ?? null,
            decidedBy,
          },
          runId,
        );
      });
      if (recorded) worker.decisions.push({ operation: record.operation, decision });
      return decision;
    };

    // Paths are judged by what they really are, not what the agent declared: symlinks
    // (including dangling ones) are followed, and the canonical form is what both the
    // containment check and the rules see.
    const contained = containOperation(operation, workspace.root, this.options.dataDir);
    if (contained.refused)
      return settle(
        { verdict: "deny", reason: contained.refused },
        "portrail:containment",
      );
    operation = contained.operation;

    const key = run.keyId
      ? this.store.get<{ policy?: unknown }>("key", run.keyId)
      : undefined;
    const context: DecisionContext = {
      keyId: run.keyId,
      keyPolicy: key?.policy ?? null,
      // The root as the filesystem spells it, so relative paths the decider builds
      // from canonical operation paths always line up.
      workspaceRoot: contained.root,
      // Everything decided in this run, plus anything allowed "for this session"
      // by an earlier run of the same session. The decider chooses what carries.
      priorDecisions: [...worker.decisions],
    };

    let decision: Decision;
    try {
      decision = await this.decider.decide(operation, context);
      // The decider took its time; the run may have been cancelled meanwhile, and a
      // yes to a run that is over must never reach the agent.
      if (decision.verdict !== "deny" && this.inactive(runId, worker.epoch))
        return NOT_ACTIVE;
    } catch (error) {
      return settle(
        { verdict: "deny", reason: `The decider failed: ${(error as Error).message}` },
        this.decider.name,
      );
    }

    if (decision.verdict !== "ask") return settle(decision, this.decider.name);

    // Park it. The run visibly waits, and whoever can answer is told.
    const expiresAt = new Date(
      Date.now() + this.options.approvalTimeoutMs,
    ).toISOString();
    this.store.tx(() => {
      const current = this.store.get<OperationRecord>("operation", operation.id)!;
      this.store.put("operation", { ...current, state: "pending", expiresAt });
      const latest = this.run(runId);
      this.store.put("run", {
        ...latest,
        operations: {
          ...(latest.operations ?? { total: 0, allowed: 0, denied: 0, asked: 0 }),
          asked: (latest.operations?.asked ?? 0) + 1,
        },
      });
      this.setState(runId, "waiting_for_approval");
      this.emitEvent(
        run.sessionId,
        "approval.requested",
        { operationId: operation.id, operation, reason: decision.reason, expiresAt },
        runId,
      );
    });

    const answered = await this.parking.park(
      operation.id,
      this.options.approvalTimeoutMs,
      () => ({
        verdict: "deny",
        reason: "No decision arrived before the deadline. Refused to be safe.",
      }),
    );

    if (answered.verdict === "allow" && this.inactive(runId, worker.epoch))
      return NOT_ACTIVE;
    const decidedBy = this.store.get<OperationRecord>(
      "operation",
      operation.id,
    )?.decidedBy;
    this.store.tx(() => {
      const latest = this.run(runId);
      // A human's answer counts like any other decision: the run's tally is what
      // `portrail run` exits on and what an automation branches on.
      const counts = {
        ...(latest.operations ?? { total: 0, allowed: 0, denied: 0, asked: 0 }),
      };
      if (decidedBy) {
        counts.total += 1;
        if (answered.verdict === "allow") counts.allowed += 1;
        else counts.denied += 1;
      }
      this.store.put("run", { ...latest, operations: counts });
      if (this.run(runId).state === "waiting_for_approval")
        this.setState(runId, "running");
    });
    if (decidedBy)
      worker.decisions.push({ operation: record.operation, decision: answered });
    return decidedBy ? answered : settle(answered, "portrail:timeout");
  }

  /** How an extension (or a person through one) answers a parked operation. */
  resolve(operationId: string, decision: Decision, actor: string) {
    const record = this.store.get<OperationRecord>("operation", operationId);
    ensure(record, 404, "NOT_FOUND", "Operation not found.");
    ensure(
      record.state === "pending",
      409,
      "NOT_PENDING",
      "This operation is not waiting for a decision.",
    );
    ensure(
      decision.verdict !== "ask",
      400,
      "INVALID_REQUEST",
      "Resolve with allow or deny.",
    );
    this.store.tx(() => {
      this.store.put("operation", {
        ...record,
        state: "decided",
        decision,
        decidedBy: actor,
        decidedAt: now(),
      });
      this.emitEvent(
        record.sessionId,
        "operation.decided",
        {
          operationId,
          verdict: decision.verdict,
          reason: decision.reason,
          rule: decision.rule ?? null,
          decidedBy: actor,
        },
        record.runId,
      );
    });
    const delivered = this.parking.resolve(operationId, decision);
    if (!delivered)
      fail(409, "NOT_PENDING", "The run stopped waiting before this decision arrived.");
  }

  listOperations(
    filter: { runId?: string; state?: OperationRecord["state"] } = {},
  ): OperationRecord[] {
    return this.store.select<OperationRecord>("operation", {
      runId: filter.runId,
      state: filter.state,
      newestFirst: true,
    });
  }

  operation(operationId: string): OperationRecord {
    const record = this.store.get<OperationRecord>("operation", operationId);
    ensure(record, 404, "NOT_FOUND", "Operation not found.");
    return record;
  }

  // -------------------------------------------------------------- control

  async cancel(runId: string, reason = "Cancelled."): Promise<RunRecord> {
    const run = this.run(runId);
    if (TERMINAL_STATES.has(run.state)) return run;
    const worker = this.workers.get(runId);
    if (run.state === "queued" || !worker) {
      this.finish(runId, "cancelled", reason);
      return this.run(runId);
    }
    this.store.put("run", { ...run, cancellationRequested: true });
    this.setState(runId, "cancelling");
    this.parking.drain("The run was cancelled.", (operationId) =>
      this.belongsTo(operationId, runId),
    );
    worker.abort.abort();
    await worker.handle?.interrupt().catch(() => {});

    // Give the agent a moment to stop on its own; after that we stop it.
    const grace = setTimeout(() => {
      if (this.workers.get(runId) === worker) {
        worker.handle?.close(true);
        this.finish(runId, "cancelled", reason);
      }
    }, 5000);
    grace.unref();
    return this.run(runId);
  }

  async steer(runId: string, text: string): Promise<void> {
    ensure(
      typeof text === "string" && text.trim(),
      400,
      "INVALID_REQUEST",
      "Text is required.",
    );
    const run = this.run(runId);
    const worker = this.workers.get(runId);
    ensure(
      worker?.handle &&
        (run.state === "running" || run.state === "waiting_for_approval"),
      409,
      "NOT_RUNNING",
      "Only a running run can be steered.",
    );
    await worker.handle.steer(text);
    this.emitEvent(run.sessionId, "run.steered", { text }, runId);
  }

  // ------------------------------------------------------------ lifecycle

  retention(retentionDays: number): RetentionResult {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const removed: RetentionResult = {
      cutoff,
      sessions: 0,
      runs: 0,
      operations: 0,
      events: 0,
      commands: 0,
    };
    this.store.tx(() => {
      // A worker's run may sit in a terminal state for a moment before the worker is gone.
      const live = new Set<string>();
      for (const runId of this.workers.keys()) {
        const run = this.store.get<RunRecord>("run", runId);
        if (run) live.add(run.sessionId);
      }
      for (const session of this.store.list<SessionRecord>("session")) {
        if (session.lastActivityAt >= cutoff || live.has(session.id)) continue;
        if (
          this.store.count("run", { sessionId: session.id, state: ACTIVE_STATES }) > 0
        )
          continue;
        removed.runs += this.store.removeWhere("run", { sessionId: session.id });
        removed.operations += this.store.removeWhere("operation", {
          sessionId: session.id,
        });
        removed.events += this.store.removeEvents(session.id);
        this.store.remove("session", session.id);
        removed.sessions += 1;
      }
      removed.commands = Number(
        this.store.db.prepare("DELETE FROM commands WHERE created_at<?").run(cutoff)
          .changes,
      );
    });
    return removed;
  }

  async shutdown() {
    this.closing = true;
    this.parking.drain("Portrail is shutting down.");
    // Stop every worker directly. A run may already be marked terminal by another
    // process (recovery on the same store), and cancel() would then skip it while
    // its task sat awaiting an agent that will never answer.
    for (const [runId, worker] of this.workers) {
      const run = this.store.get<RunRecord>("run", runId);
      if (run && !TERMINAL_STATES.has(run.state)) {
        this.store.put("run", { ...run, cancellationRequested: true });
        this.setState(runId, "cancelling");
      }
      worker.abort.abort();
      await worker.handle?.interrupt().catch(() => {});
    }
    const settled = Promise.allSettled([...this.tasks]);
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref();
    });
    await Promise.race([settled, grace]);
    for (const [runId, worker] of this.workers) {
      worker.handle?.close(true);
      this.finish(
        runId,
        "outcome_unknown",
        "Portrail stopped before the agent confirmed completion.",
      );
    }
    this.workers.clear();
  }
}

/** Places no agent may ever touch, whatever workspace it is in, as absolute paths. */
export function protectedPaths(dataDir?: string): string[] {
  const home = homedir();
  const paths = PROTECTED_HOME_ENTRIES.map((entry) => join(home, entry.path));
  if (dataDir) paths.push(dataDir);
  return paths.map((path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  });
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Device files a command may name without the workspace being a question. */
const DEVICES = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
]);

/**
 * The pieces of one word that could name something on disk: the word itself, what
 * follows `=` or `:` (`--output=/tmp/x`, `HEAD:.env`), what follows a `<` redirect,
 * and a path glued to a short option (`-o/tmp/x`).
 */
function pathCandidates(word: string): string[] {
  const parts = new Set<string>([word, ...word.split(/[=:]/)]);
  return [...parts]
    .map((part) => part.replace(/^[0-9]*</, ""))
    .flatMap((part) => {
      const attached = /^-[A-Za-z]+(\/.*)$/.exec(part);
      return attached ? [part, attached[1]!] : [part];
    })
    .filter(Boolean);
}

/**
 * Where a word points if it is a path, resolved the way the shell would: `~` from
 * home, `/…` as given, anything else against the working directory. An absolute word
 * whose first component does not exist is text (`/api/v1`, `/foo/,/bar/p`), not a path.
 */
function looksLikePath(part: string, cwd: string): string | null {
  if (part === "~" || part.startsWith("~/")) return join(homedir(), part.slice(1));
  if (part.startsWith("/")) {
    const full = resolve(part);
    if (full === "/") return full;
    const top = full.split("/")[1];
    return top && existsSync(`/${top}`) ? full : null;
  }
  return resolve(cwd, part);
}

/**
 * Every path a command names must lie inside the workspace and off the protected
 * list — the same rule a declared read or write follows. The program itself
 * (`/usr/bin/env`) may live anywhere but is still held to the protected list; device
 * files are always fine. Returns the canonical paths of what exists on disk, so the
 * decider can judge the command as a read of those files.
 */
export function judgeCommandPaths(
  segments: readonly CommandSegment[],
  cwd: string,
  root: string,
  protectedList: readonly string[],
): { refused: string | null; paths: string[] } {
  const paths = new Set<string>();
  for (const segment of segments) {
    for (const [index, word] of segment.words.entries()) {
      for (const part of pathCandidates(word)) {
        const candidate = looksLikePath(part, cwd);
        if (!candidate) continue;
        let canonical: string;
        try {
          canonical = canonicalPath(cwd, candidate);
        } catch {
          return {
            refused: `Refused: the command names ${part}, which could not be resolved.`,
            paths: [],
          };
        }
        if (
          protectedList.some(
            (p) => isWithinFold(canonical, p) || isWithinFold(p, canonical),
          )
        )
          return {
            refused: `Refused: the command touches ${part}, which is protected everywhere.`,
            paths: [],
          };
        if (DEVICES.has(canonical) || index === segment.programIndex) continue;
        if (!isWithin(canonical, root))
          return {
            refused: `Refused: the command names ${part}, which resolves outside the workspace (${canonical}).`,
            paths: [],
          };
        try {
          lstatSync(canonical);
          paths.add(canonical);
        } catch {
          // Names nothing on disk: a flag, a search term, a file that does not exist yet.
        }
      }
    }
  }
  return { refused: null, paths: [...paths] };
}

/**
 * The one check no rule can override. Every declared path is canonicalised, must
 * live inside the workspace, and must not be one of the protected paths — the
 * latter matters when someone enrols a broad directory. Returns the operation with
 * canonical paths substituted, so rules match reality.
 */
export function containOperation(
  operation: Operation,
  declaredRoot: string,
  dataDir?: string,
): { operation: Operation; refused: string | null; root: string } {
  const root = safeRealpath(declaredRoot);
  const protectedList = protectedPaths(dataDir);
  const check = (declared: string): { canonical: string; refused: string | null } => {
    if (!declared)
      return { canonical: declared, refused: `Refused: an empty path was declared.` };
    let canonical: string;
    try {
      canonical = canonicalPath(root, declared);
    } catch {
      return {
        canonical: declared,
        refused: `Refused: ${declared} could not be resolved.`,
      };
    }
    if (!isWithin(canonical, root))
      return {
        canonical,
        refused: `Refused: ${declared} resolves outside the workspace (${canonical}).`,
      };
    const hit = protectedList.find((p) => isWithinFold(canonical, p));
    if (hit)
      return {
        canonical,
        refused: `Refused: ${declared} is inside a protected directory (${hit}).`,
      };
    return { canonical, refused: null };
  };

  if (operation.kind === "write") {
    if (!operation.changes.length)
      return { operation, refused: "Refused: a write with no files declared.", root };
    const changes = [];
    for (const change of operation.changes) {
      const result = check(change.path);
      if (result.refused) return { operation, refused: result.refused, root };
      changes.push({ ...change, path: result.canonical });
    }
    return { operation: { ...operation, changes }, refused: null, root };
  }
  if (operation.kind === "read") {
    const paths = [];
    for (const path of operation.paths) {
      const result = check(path);
      if (result.refused) return { operation, refused: result.refused, root };
      paths.push(result.canonical);
    }
    return { operation: { ...operation, paths }, refused: null, root };
  }
  if (operation.kind === "exec") {
    if (!operation.command.trim())
      return { operation, refused: "Refused: an empty command.", root };
    // The directory a command runs in decides what its relative paths mean.
    const cwd = check(operation.cwd || ".");
    if (cwd.refused)
      return {
        operation,
        refused: cwd.refused.replace(/^Refused: /, "Refused: the working directory "),
        root,
      };
    // Rules match a command as text, so what text cannot express is refused here,
    // before any decider — and every path the command names is resolved against the
    // working directory and held to the workspace and the protected list, the one
    // place that knows what the text points at.
    const { segments, unjudgeable } = parseCommand(operation.command);
    if (unjudgeable)
      return {
        operation,
        refused: `Refused: the command uses ${unjudgeable}, which cannot be judged by a rule. Run it as separate plain commands.`,
        root,
      };
    const named = judgeCommandPaths(segments, cwd.canonical, root, protectedList);
    if (named.refused) return { operation, refused: named.refused, root };
    return {
      operation: { ...operation, cwd: cwd.canonical, paths: named.paths },
      refused: null,
      root,
    };
  }
  if (operation.kind === "net" && !operation.host && !operation.url)
    return {
      operation,
      refused: "Refused: a network operation with no destination.",
      root,
    };
  return { operation, refused: null, root };
}

/** Where the operating system keeps itself; nothing there is anyone's project. */
const SYSTEM_ROOTS = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/opt",
  "/lib",
  "/lib64",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/cores",
  "/System",
  "/Library",
  "/Applications",
  "/private/etc",
];

/** Why a directory may not become a workspace, or null. */
export function refuseWorkspaceRoot(declared: string, dataDir?: string): string | null {
  const canonical = safeRealpath(declared);
  const home = safeRealpath(homedir());
  if (canonical === "/" || canonical === dirname(canonical))
    return "The filesystem root cannot be a workspace.";
  if (SYSTEM_ROOTS.some((system) => isWithin(canonical, safeRealpath(system))))
    return "A system directory cannot be a workspace. Choose a project folder.";
  if (canonical === home)
    return "Your home directory cannot be a workspace. Enrol a project folder inside it.";
  if (isWithin(home, canonical))
    return "A directory above your home directory cannot be a workspace.";
  for (const p of protectedPaths(dataDir))
    if (isWithinFold(p, canonical) || isWithinFold(canonical, p))
      return `${canonical} contains or lies inside a protected directory (${p}). Choose a project folder.`;
  if (existsSync(join(canonical, ".portrail")))
    return `${canonical} contains a .portrail directory. Choose a project folder.`;
  return null;
}
