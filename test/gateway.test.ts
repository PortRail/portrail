import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { Gateway } from "../src/core/gateway.ts";
import { FakeProvider } from "../src/providers/fake/index.ts";
import { BuiltinDecider } from "../src/decide/builtin.ts";
import type { Decider, Decision } from "../src/extension.ts";
import type { Provider } from "../src/providers/types.ts";
import { script, testGateway, untilDone, tick } from "./helpers.ts";

test("a run moves queued → starting → running → succeeded and its events are ordered", async () => {
  const { gateway, events } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "hello " }, { exec: "npm test" }, { text: "bye" }]),
  });
  assert.equal(run.state, "queued");
  await untilDone(gateway, run.id);

  const final = gateway.run(run.id);
  assert.equal(final.state, "succeeded");
  assert.match(final.summary ?? "", /hello .*\[exec ok\] bye/);
  assert.ok(final.startedAt && final.completedAt);

  const types = events.filter((e) => e.runId === run.id).map((e) => e.type);
  assert.deepEqual(types.slice(0, 4), [
    "run.queued",
    "run.state_changed", // starting
    "run.state_changed", // running
    "run.started",
  ]);
  assert.ok(types.includes("operation.requested"));
  assert.ok(types.includes("operation.decided"));
  assert.ok(types.includes("command.started"));
  assert.ok(types.includes("output.text"));
  assert.equal(types.at(-1), "run.completed");

  const seqs = events.filter((e) => e.sessionId === run.sessionId).map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "sequence numbers are monotonic",
  );
  await gateway.shutdown();
});

test("denied operations do not run, and the decision is recorded with its rule", async () => {
  const { gateway, events } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([
      { exec: "rm -rf build" },
      { exec: "npm test" },
      { write: ".env" },
      { exec: "rm -rf /" },
    ]),
  });
  await untilDone(gateway, run.id);

  const decided = events.filter(
    (e) => e.runId === run.id && e.type === "operation.decided",
  );
  assert.deepEqual(
    decided.map((e) => e.data.verdict),
    ["deny", "allow", "deny", "deny"],
  );
  assert.equal(decided[0]?.data.rule, "exec:rm -rf*");
  assert.equal(decided[2]?.data.rule, "write:.env*");
  assert.equal(
    decided[3]?.data.decidedBy,
    "portrail:containment",
    "a path outside the workspace never reaches a rule",
  );
  const commands = events.filter(
    (e) => e.runId === run.id && e.type === "command.started",
  );
  assert.equal(commands.length, 1, "only the allowed command started");
  const summary = gateway.run(run.id).summary ?? "";
  assert.equal(
    (summary.match(/refused:/g) ?? []).length,
    3,
    "the agent reported every refusal",
  );
  await gateway.shutdown();
});

test("a path outside the workspace is refused before any rule is consulted", async () => {
  const calls: string[] = [];
  let seenRoot = "";
  const spy: Decider = {
    name: "spy",
    decide: async (op, context) => {
      calls.push(op.kind);
      seenRoot = context.workspaceRoot;
      return { verdict: "allow", reason: "spy allows all" };
    },
  };
  const { gateway, events, root } = testGateway({ decider: spy });
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([
      { write: "../../etc/passwd" },
      { read: "/etc/hosts" },
      { write: "inside.txt" },
    ]),
  });
  await untilDone(gateway, run.id);

  const decided = events.filter(
    (e) => e.runId === run.id && e.type === "operation.decided",
  );
  assert.equal(decided[0]?.data.decidedBy, "portrail:containment");
  assert.equal(decided[1]?.data.decidedBy, "portrail:containment");
  assert.equal(decided[2]?.data.decidedBy, "spy");
  assert.deepEqual(
    calls,
    ["write"],
    "the decider only ever saw the in-workspace operation",
  );
  assert.equal(
    seenRoot,
    realpathSync.native(root),
    "the decider sees the workspace root as the filesystem spells it",
  );
  await gateway.shutdown();
});

test("cancelling a hanging run ends it as cancelled", async () => {
  const { gateway } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "working" }, { hang: true }]),
  });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gateway.run(run.id).state, "running");

  await gateway.cancel(run.id, "test cancel");
  await untilDone(gateway, run.id);
  const final = gateway.run(run.id);
  assert.equal(final.state, "cancelled");
  assert.equal(final.cancellationRequested, true);
  await gateway.shutdown();
});

test("an agent that dies after starting leaves outcome_unknown and flags the session", async () => {
  const { gateway } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ exec: "npm test" }, { crash: "segfault" }]),
  });
  await untilDone(gateway, run.id);

  const final = gateway.run(run.id);
  assert.equal(final.state, "outcome_unknown");
  assert.match(final.summary ?? "", /segfault/);
  assert.equal(gateway.session(run.sessionId).state, "attention_required");
  assert.throws(
    () => gateway.createRun({ sessionId: run.sessionId, prompt: "again" }),
    /needs attention/,
  );
  await gateway.shutdown();
});

test("a restart marks in-flight work unknown and never replays it", async () => {
  const { gateway, store } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ hang: true }]),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gateway.run(run.id).state, "running");

  // Simulate the process dying: no shutdown, just a new Gateway on the same store.
  const providers = new Map([["fake" as const, new FakeProvider()]]);
  const reborn = new Gateway(
    store,
    providers,
    new BuiltinDecider({ allow: [], deny: [] }),
    {
      maxConcurrent: 1,
      defaultMaxSeconds: 60,
      approvalTimeoutMs: 100,
      maxQueued: 10,
    },
  );
  reborn.recover();
  const recovered = reborn.run(run.id);
  assert.equal(recovered.state, "outcome_unknown");
  assert.match(recovered.summary ?? "", /restarted/);
  await gateway.shutdown();
  await reborn.shutdown();
});

test("an `ask` verdict parks the run until resolved; the deadline refuses", async () => {
  const asker: Decider = {
    name: "asker",
    decide: async () => ({ verdict: "ask", reason: "needs a human" }),
  };
  const { gateway, events } = testGateway({ decider: asker, approvalTimeoutMs: 150 });

  // First run: we answer.
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ exec: "npm test" }]),
  });
  const parked = await new Promise<string>((resolve) => {
    gateway.on("event", (e) => {
      if (e.runId === run.id && e.type === "approval.requested")
        resolve(e.data.operationId as string);
    });
  });
  assert.equal(gateway.run(run.id).state, "waiting_for_approval");
  assert.equal(gateway.listOperations({ state: "pending" }).length, 1);

  gateway.resolve(parked, { verdict: "allow", reason: "human said yes" }, "test-user");
  await untilDone(gateway, run.id);
  assert.equal(gateway.run(run.id).state, "succeeded");
  const decided = events.find(
    (e) => e.runId === run.id && e.type === "operation.decided",
  );
  assert.equal(decided?.data.decidedBy, "test-user");
  assert.equal(decided?.data.verdict, "allow");

  // Second run: nobody answers.
  const slow = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ exec: "npm test" }]),
  });
  await untilDone(gateway, slow.id);
  const timedOut = events.find(
    (e) => e.runId === slow.id && e.type === "operation.decided",
  );
  assert.equal(timedOut?.data.verdict, "deny");
  assert.equal(timedOut?.data.decidedBy, "portrail:timeout");
  assert.match(gateway.run(slow.id).summary ?? "", /refused: No decision arrived/);
  await gateway.shutdown();
});

test("a session-scoped allow is offered to the decider on the next run of the same session — and still recorded", async () => {
  const seen: Array<{ priors: number; carried: boolean }> = [];
  const remembering: Decider = {
    name: "remembering",
    decide: async (operation, context) => {
      const carried = context.priorDecisions.some(
        (prior) =>
          prior.decision.scope === "session" &&
          prior.decision.verdict === "allow" &&
          prior.operation.kind === "exec" &&
          operation.kind === "exec" &&
          prior.operation.command === operation.command,
      );
      seen.push({ priors: context.priorDecisions.length, carried });
      return carried
        ? {
            verdict: "allow",
            reason: "Allowed earlier for this session.",
            scope: "session",
          }
        : { verdict: "ask", reason: "needs a human" };
    },
  };
  const { gateway } = testGateway({ decider: remembering });
  const first = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ exec: "make deploy" }]),
  });
  const parked = await new Promise<string>((resolve) => {
    gateway.on("event", (e) => {
      if (e.runId === first.id && e.type === "approval.requested")
        resolve(e.data.operationId as string);
    });
  });
  gateway.resolve(
    parked,
    { verdict: "allow", reason: "yes, for this session", scope: "session" },
    "test-user",
  );
  await untilDone(gateway, first.id);

  const second = gateway.createRun({
    sessionId: gateway.run(first.id).sessionId,
    prompt: script([{ exec: "make deploy" }]),
  });
  await untilDone(gateway, second.id);
  assert.equal(gateway.run(second.id).state, "succeeded");
  assert.deepEqual(
    seen.at(-1),
    { priors: 1, carried: true },
    "the earlier session-scoped allow reached the decider",
  );
  // The point of removing the provider-side cache: the second operation is decided and recorded too.
  const ops = gateway.listOperations({ runId: second.id });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.decision?.verdict, "allow");
  assert.equal(ops[0]?.decidedBy, "remembering");
  await gateway.shutdown();
});

test("one run per session, and the queue advances when a run finishes", async () => {
  const { gateway } = testGateway({ maxConcurrent: 1 });
  const first = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ sleep: 60 }]),
  });
  assert.throws(
    () => gateway.createRun({ sessionId: first.sessionId, prompt: "x" }),
    /already has a run/,
  );
  const second = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "2" }]),
  });
  await tick();
  assert.equal(gateway.run(second.id).state, "queued", "concurrency limit holds it");
  await untilDone(gateway, first.id);
  await untilDone(gateway, second.id);
  assert.equal(gateway.run(second.id).state, "succeeded");
  await gateway.shutdown();
});

test("a session keeps its native id, so a second run resumes the same conversation", async () => {
  const { gateway } = testGateway();
  const first = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "1" }]),
  });
  await untilDone(gateway, first.id);
  const nativeId = gateway.session(first.sessionId).nativeSessionId;
  assert.ok(nativeId);

  const second = gateway.createRun({
    sessionId: first.sessionId,
    prompt: script([{ text: "2" }]),
  });
  await untilDone(gateway, second.id);
  assert.equal(gateway.session(first.sessionId).nativeSessionId, nativeId);
  await gateway.shutdown();
});

test("shutdown refuses new runs and leaves active ones unknown rather than guessing", async () => {
  const { gateway } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ hang: true }]),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await gateway.shutdown();
  assert.ok(["cancelled", "outcome_unknown"].includes(gateway.run(run.id).state));
  assert.throws(
    () => gateway.createRun({ workspace: "work", agent: "fake", prompt: "x" }),
    /shutting down/,
  );
});

test("a second Gateway on the same store (an offline CLI command) leaves in-flight runs alone", async () => {
  // Regression guard: `portrail logs` during a run must never mark it outcome_unknown.
  const { gateway, store } = testGateway();
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ hang: true }]),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gateway.run(run.id).state, "running");

  const bystander = new Gateway(
    store,
    new Map(),
    new BuiltinDecider({ allow: [], deny: [] }),
    {
      maxConcurrent: 0,
      defaultMaxSeconds: 60,
      approvalTimeoutMs: 1,
      maxQueued: 0,
    },
  );
  assert.equal(bystander.listWorkspaces().length, 1, "it can still read");
  assert.equal(gateway.run(run.id).state, "running", "constructing it changed nothing");
  assert.equal(gateway.session(run.sessionId).state, "open");

  await gateway.cancel(run.id);
  await untilDone(gateway, run.id);
  assert.equal(gateway.run(run.id).state, "cancelled", "the owner's result wins");
  await gateway.shutdown();
});

test("a run left queued by a previous process is dispatched when the next process recovers", async () => {
  const { gateway, store } = testGateway({ maxConcurrent: 1 });
  gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ hang: true }]),
  });
  const second = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "later" }]),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gateway.run(second.id).state, "queued");
  await gateway.shutdown();
  assert.equal(
    gateway.run(second.id).state,
    "queued",
    "shutdown leaves what never started where it was",
  );

  const reborn = new Gateway(
    store,
    new Map([["fake" as const, new FakeProvider()]]),
    new BuiltinDecider({ allow: [], deny: [] }),
    {
      maxConcurrent: 1,
      defaultMaxSeconds: 60,
      approvalTimeoutMs: 100,
      maxQueued: 10,
    },
  );
  reborn.recover();
  await untilDone(reborn, second.id);
  assert.equal(reborn.run(second.id).state, "succeeded");
  await reborn.shutdown();
});

test("a provider that lost its agent leaves the run unknown and the session needing attention, keeping the provider's own account", async () => {
  const lost: Provider = {
    id: "fake",
    probe: async () => ({ ready: true, detail: "stub" }) as never,
    start: async (context) => {
      context.emit({ type: "started", nativeSessionId: null });
      context.emit({ type: "text", text: "partial work" } as never);
      return {
        nativeSessionId: () => null,
        interrupt: async () => {},
        steer: async () => {},
        close() {},
        done: Promise.resolve({
          state: "outcome_unknown" as const,
          summary: "the agent process exited mid-turn",
        }),
      };
    },
  };
  const { gateway } = testGateway({ providers: new Map([["fake" as const, lost]]) });
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: "anything",
  });
  await untilDone(gateway, run.id);
  const final = gateway.run(run.id);
  assert.equal(final.state, "outcome_unknown");
  assert.equal(
    final.summary,
    "the agent process exited mid-turn",
    "the provider's reason, not the partial output",
  );
  assert.equal(gateway.session(run.sessionId).state, "attention_required");
  await gateway.shutdown();
});

test("an allow that arrives after the run was cancelled is not delivered to the agent", async () => {
  let release!: (decision: Decision) => void;
  const slow: Decider = {
    name: "slow",
    decide: () => new Promise<Decision>((resolve) => (release = resolve)),
  };
  const { gateway, events } = testGateway({ decider: slow });
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ exec: "npm test" }, { text: "after" }]),
  });
  await new Promise<void>((resolve) =>
    gateway.on(
      "event",
      (event) =>
        event.runId === run.id && event.type === "operation.requested" && resolve(),
    ),
  );
  await gateway.cancel(run.id, "changed my mind");
  release({ verdict: "allow", reason: "too late" });
  await untilDone(gateway, run.id);
  assert.equal(gateway.run(run.id).state, "cancelled");
  assert.ok(
    !events.some((event) => event.runId === run.id && event.type === "command.started"),
    "the agent never got a yes",
  );
  assert.ok(
    !events.some(
      (event) =>
        event.runId === run.id &&
        event.type === "operation.decided" &&
        event.data.verdict === "allow",
    ),
    "no allow was recorded either",
  );
  await gateway.shutdown();
});

test("the queue limit counts only queued runs, however many finished ones exist", async () => {
  const { gateway, store, workspace } = testGateway({ maxQueued: 2, maxConcurrent: 1 });
  store.put("session", {
    id: "old",
    workspaceId: workspace.id,
    agent: "fake",
    state: "closed",
    nativeSessionId: null,
    lastEventSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    keyId: null,
  });
  for (let i = 0; i < 300; i++)
    store.put("run", {
      id: `done${i}`,
      sessionId: "old",
      state: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      operationIds: [],
    });
  gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ hang: true }]),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "a" }]),
  });
  gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ text: "b" }]),
  });
  assert.throws(
    () =>
      gateway.createRun({
        workspace: "work",
        agent: "fake",
        prompt: script([{ text: "c" }]),
      }),
    /QUEUE_FULL|Too many runs/,
  );
  assert.equal(gateway.listRuns().length, 303);
  assert.deepEqual(gateway.listOperations({ state: "pending" }), []);
  assert.equal(store.select("run", { state: "queued" }).length, 2);
  await gateway.shutdown();
});

test("a decision answered by hand earlier in the same run reaches the decider as a prior", async () => {
  const seen: number[] = [];
  const asking: Decider = {
    name: "asking",
    decide: async (_operation, context) => {
      seen.push(context.priorDecisions.length);
      return { verdict: "ask", reason: "a person decides" };
    },
  };
  const { gateway } = testGateway({ decider: asking, approvalTimeoutMs: 5000 });
  const run = gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ exec: "a" }, { exec: "b" }]),
  });
  const answered: string[] = [];
  for (let i = 0; i < 2; i++) {
    for (
      let tick = 0;
      tick < 200 &&
      !gateway
        .listOperations({ state: "pending" })
        .some((op) => !answered.includes(op.id));
      tick++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = gateway
      .listOperations({ state: "pending" })
      .find((op) => !answered.includes(op.id))!;
    answered.push(pending.id);
    gateway.resolve(
      pending.id,
      { verdict: "allow", reason: "ok", scope: "run" },
      "tester",
    );
  }
  await untilDone(gateway, run.id);
  assert.deepEqual(seen, [0, 1], "the second question saw the first answer");
  await gateway.shutdown();
});
