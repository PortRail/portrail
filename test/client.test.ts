import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { PortrailClient } from "../src/client/index.ts";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const running = {
  id: "run_1",
  state: "running",
  operations: { total: 0, allowed: 0, denied: 0, asked: 0 },
};
const client = (
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  extra: Record<string, unknown> = {},
) =>
  new PortrailClient({
    baseUrl: "http://127.0.0.1:1",
    token: "prt_test_token_value",
    fetch: fetch as typeof globalThis.fetch,
    ...extra,
  });

test(
  "wait() refuses an already-aborted signal without a request",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const c = client(async () => (calls++, json(running)));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(c.runs.wait("run_1", { signal: controller.signal }));
    assert.equal(calls, 0);
  },
);

test(
  "wait() stops sleeping when aborted and leaves no listener behind",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const c = client(async () => (calls++, json(running)));
    const controller = new AbortController();
    const waiting = c.runs.wait("run_1", {
      intervalMs: 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(waiting);
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  },
);

test(
  "wait() polls without accumulating abort listeners",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    const c = client(
      async () => (
        calls++,
        json(calls < 4 ? running : { ...running, state: "succeeded" })
      ),
    );
    const controller = new AbortController();
    const run = await c.runs.wait("run_1", {
      intervalMs: 1,
      signal: controller.signal,
    });
    assert.equal(run.state, "succeeded");
    assert.equal(calls, 4);
    assert.equal(
      getEventListeners(controller.signal, "abort").length,
      0,
      "each sleep removed its own listener",
    );
  },
);

test(
  "a caller's signal is combined with the request timeout, not substituted for it",
  { timeout: 5000 },
  async () => {
    const c = client(
      (_url, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)),
        ),
      { timeoutMs: 20 },
    );
    await assert.rejects(c.runs.get("run_1"), /timeout|TimeoutError/i);
    const controller = new AbortController();
    await assert.rejects(
      c.request("/runs/run_1", { signal: controller.signal }),
      /timeout|TimeoutError/i,
    );
  },
);

test(
  "Idempotency-Key is sent for run creation only, and health() carries the bearer",
  { timeout: 5000 },
  async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const c = client(
      async (url, init) => (
        seen.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        }),
        json({ id: "x", items: [] })
      ),
    );
    await c.runs.create({ prompt: "p", workspace: "w", agent: "fake" });
    await c.runs.cancel("run_1");
    await c.keys.create({ name: "k" });
    await c.health();
    assert.ok(seen[0]!.headers["idempotency-key"], "run creation is retried safely");
    assert.equal(
      seen[1]!.headers["idempotency-key"],
      undefined,
      "cancel is not idempotent on the server",
    );
    assert.equal(
      seen[2]!.headers["idempotency-key"],
      undefined,
      "a key is created once per call, never replayed from a stored token",
    );
    assert.match(seen[3]!.headers.authorization ?? "", /^Bearer prt_test_token_value$/);
  },
);
