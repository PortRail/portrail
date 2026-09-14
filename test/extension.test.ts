import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { Keys } from "../src/core/keys.ts";
import type { Extension, ExtensionHost } from "../src/extension.ts";
import { script, testGateway, untilDone } from "./helpers.ts";

/**
 * A stand-in for Portrail Pro: asks about every exec, exposes the pending list on
 * a route of its own, and resolves through the host. This is the seam contract.
 */
function fakePro(): Extension & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: "fake-pro",
    version: "0.0.0-test",
    seen,
    decider: () => {
      return {
        name: "fake-pro-decider",
        decide: async (operation) =>
          operation.kind === "exec"
            ? { verdict: "ask", reason: "fake-pro wants a human" }
            : { verdict: "allow", reason: "fake-pro allows non-exec" },
      };
    },
    routes: (app, host) => {
      app.get("/v1/pending", async () => ({
        items: host.store.list("operation").filter((op: any) => op.state === "pending"),
      }));
      app.post("/v1/pending/:id/allow", async (request) => {
        host.resolve(
          (request.params as any).id,
          { verdict: "allow", reason: "approved via fake-pro" },
          "fake-pro-user",
        );
        return { ok: true };
      });
    },
    onEvent: (event) => {
      seen.push(event.type);
    },
  };
}

test("an extension swaps the decider, mounts routes, and resolves parked operations through the host", async () => {
  const { gateway, store } = testGateway({ approvalTimeoutMs: 5000 });
  const pro = fakePro();
  const host: ExtensionHost = {
    version: "test",
    dataDir: mkdtempSync(join(tmpdir(), "portrail-ext-")),
    store,
    gateway,
    options: {},
    resolve: (id, decision, actor) => gateway.resolve(id, decision, actor),
  };
  gateway.useDecider(pro.decider!(host)!);
  gateway.on("event", pro.onEvent!);

  const keys = new Keys(store);
  const { token } = keys.create({ name: "t" });
  const app = await createApp({
    gateway,
    store,
    keys,
    dataDir: host.dataDir,
    extension: pro,
    agentStatus: async () => [],
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  // Start a run whose only exec will park.
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers,
    payload: {
      agent: "fake",
      workspace: "work",
      prompt: script([{ write: "a.txt" }, { exec: "npm test" }, { text: "done" }]),
    },
  });
  assert.equal(created.statusCode, 202);
  const run = created.json();

  // Wait until it parks.
  for (let i = 0; i < 50 && gateway.run(run.id).state !== "waiting_for_approval"; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(gateway.run(run.id).state, "waiting_for_approval");

  // The extension's own route sees it.
  const pending = (
    await app.inject({ method: "GET", url: "/v1/pending", headers })
  ).json();
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].operation.kind, "exec");

  // And resolves it through the host.
  const approved = await app.inject({
    method: "POST",
    url: `/v1/pending/${pending.items[0].id}/allow`,
    headers,
    payload: {},
  });
  assert.equal(approved.statusCode, 200);
  await untilDone(gateway, run.id);

  const final = gateway.run(run.id);
  assert.equal(final.state, "succeeded");
  assert.match(final.summary ?? "", /\[exec ok\] done/);
  const decided = gateway
    .listOperations({ runId: run.id })
    .find((op) => op.operation.kind === "exec");
  assert.equal(decided?.decidedBy, "fake-pro-user");
  assert.ok(
    pro.seen.includes("approval.requested"),
    "the extension observed the approval event",
  );
  assert.ok(pro.seen.includes("run.completed"));

  // Health reports the extension.
  const health = (await app.inject({ method: "GET", url: "/health", headers })).json();
  assert.deepEqual(health.pro, {
    name: "fake-pro",
    version: "0.0.0-test",
    active: true,
    detail: "",
  });

  await app.close();
  await gateway.shutdown();
});

test("without an extension, /health says so and no pro routes exist", async () => {
  const { gateway, store } = testGateway();
  const keys = new Keys(store);
  const app = await createApp({
    gateway,
    store,
    keys,
    dataDir: mkdtempSync(join(tmpdir(), "portrail-ext-")),
    extension: null,
    agentStatus: async () => [],
  });
  const anonymous = (await app.inject({ method: "GET", url: "/health" })).json();
  assert.ok(
    !("pro" in anonymous),
    "without a credential, health says nothing about extensions",
  );
  const { token } = keys.create({ name: "t" });
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().pro,
    null,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/pending" })).statusCode,
    404,
  );
  await app.close();
  await gateway.shutdown();
});

test("--relay without Pro is refused with a reason, not silently ignored", async () => {
  const { assemble } = await import("../src/daemon.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "portrail-norelay-"));
  await assert.rejects(
    assemble({
      home,
      noExtension: true,
      extensionOptions: { relay: "https://relay.example.test" },
    }),
    /relay mode is part of Portrail Pro, and Pro is not installed/,
  );
  await assert.rejects(
    assemble({ home, noExtension: true, extensionOptions: { frobnicate: true } }),
    /Unknown option --frobnicate/,
  );
});

test("portrail/extension exports what an extension needs to judge as the core does", async () => {
  const surface = await import("../src/extension.ts");
  for (const name of [
    "analyseOperation",
    "parseCommand",
    "containOperation",
    "parsePattern",
    "recursiveReadOf",
    "globToRegExp",
    "sedObjection",
    "reachableFiles",
  ] as const)
    assert.equal(typeof surface[name], "function", `${name} is exported`);
});

test("an error raised by an extension built against its own copy of the core keeps its status", async () => {
  const { gateway, store } = testGateway();
  const foreign = (status: number, code: string) =>
    Object.assign(new Error(`${code} from another copy`), {
      name: "PortrailError",
      status,
      code,
      details: {},
      toJSON() {
        return {
          error: { code, message: `${code} from another copy`, retryable: false },
        };
      },
    });
  const extension: Extension = {
    name: "other-copy",
    version: "0",
    routes: (app) => {
      app.get("/v1/pro/teapot", async () => {
        throw foreign(418, "TEAPOT");
      });
      app.get("/v1/pro/locked", async () => {
        throw foreign(401, "UNAUTHORIZED");
      });
    },
  };
  const keys = new Keys(store);
  const { token } = keys.create({ name: "t" });
  const app = await createApp({
    gateway,
    store,
    keys,
    dataDir: mkdtempSync(join(tmpdir(), "portrail-ext-")),
    extension,
    agentStatus: async () => [],
  });
  const headers = { authorization: `Bearer ${token}` };

  const teapot = await app.inject({ method: "GET", url: "/v1/pro/teapot", headers });
  assert.equal(teapot.statusCode, 418);
  assert.equal(teapot.json().error.code, "TEAPOT");

  // A foreign 401 counts toward the lockout like our own.
  const original = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 10; i++) {
      const refused = await app.inject({
        method: "GET",
        url: "/v1/pro/locked",
        headers,
        remoteAddress: "203.0.113.77",
      });
      assert.equal(refused.statusCode, 401);
    }
    const locked = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers,
      remoteAddress: "203.0.113.77",
    });
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.json().error.code, "TOO_MANY_FAILURES");
  } finally {
    console.error = original;
  }
  await app.close();
});
