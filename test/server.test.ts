import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { Keys } from "../src/core/keys.ts";
import { parseSSE } from "../src/client/index.ts";
import { script, testGateway, untilDone } from "./helpers.ts";

async function serverWithKey(scopes?: string[]) {
  const ctx = testGateway({ approvalTimeoutMs: 1000 });
  const keys = new Keys(ctx.store);
  const { token, key } = keys.create({ name: "t", scopes });
  const app = await createApp({
    gateway: ctx.gateway,
    store: ctx.store,
    keys,
    dataDir: mkdtempSync(join(tmpdir(), "portrail-srv-")),
    extension: null,
    agentStatus: async () => [{ id: "fake", ready: true }],
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { ...ctx, keys, key, token, app, headers, close: async () => { await app.close(); await ctx.gateway.shutdown(); } };
}

test("keys: missing, wrong, revoked and under-scoped keys are refused with distinct codes", async () => {
  const s = await serverWithKey(["runs:read"]);
  assert.equal((await s.app.inject({ method: "GET", url: "/v1/runs" })).json().error.code, "UNAUTHORIZED");
  assert.equal((await s.app.inject({ method: "GET", url: "/v1/runs", headers: { authorization: "Bearer prt_nope_nope_nope_nope_nope" } })).json().error.code, "UNAUTHORIZED");
  assert.equal((await s.app.inject({ method: "GET", url: "/v1/runs", headers: s.headers })).statusCode, 200);
  const forbidden = await s.app.inject({ method: "POST", url: "/v1/runs", headers: s.headers, payload: { prompt: "x" } });
  assert.equal(forbidden.json().error.code, "FORBIDDEN");
  s.keys.revoke(s.key.id);
  assert.equal((await s.app.inject({ method: "GET", url: "/v1/runs", headers: s.headers })).json().error.code, "KEY_REVOKED");
  await s.close();
});

test("wait= holds the response and returns the finished run; without it 202 comes back at once", async () => {
  const s = await serverWithKey();
  const quick = await s.app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: s.headers,
    payload: { agent: "fake", workspace: "work", prompt: script([{ sleep: 100 }, { text: "late" }]) },
  });
  assert.equal(quick.statusCode, 202);
  assert.equal(quick.json().state, "queued");

  const held = await s.app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: s.headers,
    payload: { agent: "fake", workspace: "work", prompt: script([{ text: "fast" }]), wait: 5 },
  });
  assert.equal(held.statusCode, 200);
  assert.equal(held.json().state, "succeeded");
  assert.equal(held.json().summary, "fast");
  assert.equal(held.headers["x-portrail-wait"], "1", "held responses are marked");
  await untilDone(s.gateway, quick.json().id);
  await s.close();
});

test("the same Idempotency-Key returns the same run; a different body conflicts", async () => {
  const s = await serverWithKey();
  const payload = { agent: "fake", workspace: "work", prompt: script([{ text: "once" }]), wait: 5 };
  const headers = { ...s.headers, "idempotency-key": "retry-me-please" };
  const first = await s.app.inject({ method: "POST", url: "/v1/runs", headers, payload });
  const second = await s.app.inject({ method: "POST", url: "/v1/runs", headers, payload });
  assert.equal(first.json().id, second.json().id);
  assert.equal(s.gateway.listRuns().length, 1, "one run, not two");
  const clash = await s.app.inject({ method: "POST", url: "/v1/runs", headers, payload: { ...payload, prompt: "different" } });
  assert.equal(clash.json().error.code, "IDEMPOTENCY_CONFLICT");
  await s.close();
});

test("SSE replays from a cursor, streams live, and closes after run.completed", async () => {
  const s = await serverWithKey();
  const created = await s.app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: s.headers,
    payload: { agent: "fake", workspace: "work", prompt: script([{ text: "a" }, { exec: "npm test" }, { text: "b" }]), wait: 5 },
  });
  const run = created.json();
  const response = await s.app.inject({ method: "GET", url: `/v1/runs/${run.id}/events`, headers: s.headers, payloadAsStream: false });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] as string, /text\/event-stream/);
  const types = [...response.body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.equal(types[0], "run.queued");
  assert.equal(types.at(-1), "run.completed");
  assert.ok(types.includes("command.started"));

  // Replay from the middle.
  const ids = [...response.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  const middle = ids[Math.floor(ids.length / 2)]!;
  const partial = await s.app.inject({ method: "GET", url: `/v1/runs/${run.id}/events`, headers: { ...s.headers, "last-event-id": String(middle) } });
  const partialIds = [...partial.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(partialIds.every((id) => id > middle), "only events after the cursor");

  const ahead = await s.app.inject({ method: "GET", url: `/v1/runs/${run.id}/events?after=999999`, headers: s.headers });
  assert.equal(ahead.json().error.code, "INVALID_CURSOR");
  await s.close();
});

test("the client's SSE parser survives arbitrary byte boundaries and multi-line data", async () => {
  const frames = 'id: 1\nevent: a\ndata: {"seq":1,"sessionId":"s","type":"a","data":{"t":"héllo"}}\n\n' +
    'id: 2\nevent: b\ndata: {"seq":2,\ndata: "sessionId":"s","type":"b","data":{}}\n\n';
  const bytes = Buffer.from(frames, "utf8");
  for (const cut of [1, 7, 30, 61, bytes.length - 3]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, cut));
        controller.enqueue(bytes.subarray(cut));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSSE(stream)) events.push(event);
    assert.equal(events.length, 2, `cut at ${cut}`);
    assert.equal((events[0] as any).data.t, "héllo");
  }
});

test("workspace and key admin need their scopes; a key cannot revoke itself", async () => {
  const s = await serverWithKey();
  const ws = await s.app.inject({ method: "POST", url: "/v1/workspaces", headers: s.headers, payload: { name: "second", root: mkdtempSync(join(tmpdir(), "ws-")) } });
  assert.equal(ws.statusCode, 201);
  const dup = await s.app.inject({ method: "POST", url: "/v1/workspaces", headers: s.headers, payload: { name: "second", root: "/tmp" } });
  assert.equal(dup.json().error.code, "ALREADY_EXISTS");

  const created = await s.app.inject({ method: "POST", url: "/v1/keys", headers: s.headers, payload: { name: "zap", scopes: ["runs:write"], expiresInDays: 30 } });
  assert.equal(created.statusCode, 201);
  assert.match(created.json().token, /^prt_/);
  assert.ok(!("hash" in created.json()), "hash never leaves the server");
  const self = await s.app.inject({ method: "DELETE", url: `/v1/keys/${s.key.id}`, headers: s.headers });
  assert.equal(self.statusCode, 409);
  await s.close();
});

test("the free local ask: a parked operation is answered only with the token from daemon.json, once", async () => {
  const { BuiltinDecider } = await import("../src/decide/builtin.ts");
  const ctx = testGateway({ approvalTimeoutMs: 3000, decider: new BuiltinDecider({ allow: ["exec:ls*"], deny: [], ask: ["exec:*"] }) });
  const keys = new Keys(ctx.store);
  const { token } = keys.create({ name: "remote", scopes: ["runs:write", "runs:read", "approvals:decide"] });
  const localToken = "local-secret-for-this-test";
  const app = await createApp({ gateway: ctx.gateway, store: ctx.store, keys, dataDir: mkdtempSync(join(tmpdir(), "portrail-srv-")), extension: null, localToken, agentStatus: async () => [] });
  const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const run = (await app.inject({ method: "POST", url: "/v1/runs", headers: bearer, payload: { agent: "fake", workspace: "work", prompt: script([{ exec: "terraform apply" }, { text: "done" }]) } })).json();
  await new Promise<void>((resolve) => ctx.gateway.on("event", (e) => e.runId === run.id && e.type === "approval.requested" && resolve()));
  const pending = ctx.gateway.listOperations({ runId: run.id, state: "pending" });
  assert.equal(pending.length, 1);
  const id = pending[0]!.id;

  // A full-scope API key is not enough: this is not a remote decision.
  for (const headers of [bearer, { ...bearer, "x-portrail-local": "wrong" }, { "content-type": "application/json" }]) {
    const refused = await app.inject({ method: "POST", url: `/v1/operations/${id}/answer`, headers, payload: { verdict: "allow" } });
    assert.equal(refused.statusCode, 403, JSON.stringify(headers));
    assert.match(refused.json().error.message, /only from this machine/);
  }
  assert.equal(ctx.gateway.run(run.id).state, "waiting_for_approval");

  const list = await app.inject({ method: "GET", url: "/v1/operations/pending", headers: { "x-portrail-local": localToken } });
  assert.deepEqual(list.json().items.map((op: any) => op.id), [id]);

  const answered = await app.inject({ method: "POST", url: `/v1/operations/${id}/answer`, headers: { "x-portrail-local": localToken, "content-type": "application/json" }, payload: { verdict: "allow", by: "alice" } });
  assert.equal(answered.statusCode, 200, answered.body);
  assert.equal(answered.json().decidedBy, "local:alice");
  assert.equal(answered.json().decision.scope, "once");
  await untilDone(ctx.gateway, run.id);
  assert.equal(ctx.gateway.run(run.id).state, "succeeded");
  const decided = ctx.events.find((e) => e.runId === run.id && e.type === "operation.decided");
  assert.equal(decided?.data.decidedBy, "local:alice", "the answer is on the record like any decision");

  // Once: the same answer again is refused, and the run did not need it.
  const again = await app.inject({ method: "POST", url: `/v1/operations/${id}/answer`, headers: { "x-portrail-local": localToken, "content-type": "application/json" }, payload: { verdict: "allow" } });
  assert.equal(again.statusCode, 409);
  assert.equal((await app.inject({ method: "GET", url: "/v1/operations/pending", headers: { "x-portrail-local": localToken } })).json().items.length, 0);

  // The same operation asked again in a new run parks again: nothing was remembered.
  const second = (await app.inject({ method: "POST", url: "/v1/runs", headers: bearer, payload: { agent: "fake", workspace: "work", prompt: script([{ exec: "terraform apply" }]) } })).json();
  await new Promise<void>((resolve) => ctx.gateway.on("event", (e) => e.runId === second.id && e.type === "approval.requested" && resolve()));
  assert.equal(ctx.gateway.run(second.id).state, "waiting_for_approval");
  await app.inject({ method: "POST", url: `/v1/operations/${ctx.gateway.listOperations({ runId: second.id, state: "pending" })[0]!.id}/answer`, headers: { "x-portrail-local": localToken, "content-type": "application/json" }, payload: { verdict: "deny" } });
  await untilDone(ctx.gateway, second.id);
  assert.equal(ctx.gateway.run(second.id).operations?.denied, 1);

  await app.close();
  await ctx.gateway.shutdown();
});

test("without a local token the answer routes do not exist", async () => {
  const s = await serverWithKey();
  assert.equal((await s.app.inject({ method: "GET", url: "/v1/operations/pending", headers: { "x-portrail-local": "x" } })).statusCode, 404);
  await s.close();
});

test("a replayed stream delivers every event of the run before closing, and the next run in the session still streams", async () => {
  const s = await serverWithKey();
  const steps = Array.from({ length: 30 }, (_, i) => ({ exec: `ls ${i}` }));
  const a = (await s.app.inject({ method: "POST", url: "/v1/runs", headers: s.headers, payload: { agent: "fake", workspace: "work", prompt: script(steps), wait: 5 } })).json();
  assert.equal(a.state, "succeeded");
  const seqs = (runId: string) => s.store.events(a.sessionId).filter((event) => event.runId === runId).map((event) => event.seq);
  const expected = seqs(a.id);
  assert.ok(expected.length > 120, `need more than one window of events, got ${expected.length}`);

  const ids = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  const replay = await s.app.inject({ method: "GET", url: `/v1/runs/${a.id}/events`, headers: s.headers });
  assert.deepEqual(ids(replay.body), expected, "every event of the run, in order");
  assert.equal([...replay.body.matchAll(/^event: (.+)$/gm)].at(-1)?.[1], "run.completed");

  const middle = expected[Math.floor(expected.length / 2)]!;
  const resumed = await s.app.inject({ method: "GET", url: `/v1/runs/${a.id}/events?after=${middle}`, headers: s.headers });
  assert.deepEqual(ids(resumed.body), expected.filter((seq) => seq > middle));

  const b = (await s.app.inject({ method: "POST", url: "/v1/runs", headers: s.headers, payload: { session: a.sessionId, prompt: script([{ text: "second" }]), wait: 5 } })).json();
  assert.equal(b.state, "succeeded");
  const streamB = await s.app.inject({ method: "GET", url: `/v1/runs/${b.id}/events`, headers: s.headers });
  assert.deepEqual(ids(streamB.body), seqs(b.id), "the second run's events are not eaten by the first run's allowance");
  await s.close();
});

test("run bodies are validated, not coerced", async () => {
  const s = await serverWithKey();
  const post = (payload: unknown) => s.app.inject({ method: "POST", url: "/v1/runs", headers: s.headers, payload: payload as Record<string, unknown> });
  const base = { agent: "fake", workspace: "work", prompt: "x" };
  const prompt = await post({ ...base, prompt: {} });
  assert.equal(prompt.statusCode, 400);
  assert.match(prompt.json().error.message, /prompt must be a string/);
  assert.equal((await post({ ...base, session: {} })).statusCode, 400, "an object where a session id belongs is a bad request, not a crash");
  assert.equal((await post({ ...base, model: { a: 1 } })).statusCode, 400);
  assert.equal((await post({ ...base, maxSeconds: "60" })).statusCode, 400);
  assert.equal((await post({ ...base, metadata: "nope" })).statusCode, 400);
  assert.equal((await post({ ...base, metadata: { blob: "x".repeat(17 * 1024) } })).json().error.code, "PAYLOAD_TOO_LARGE");
  assert.equal((await post([])).statusCode, 400);
  assert.equal(s.gateway.listRuns().length, 0, "nothing malformed became a run");
  await s.close();
});
