import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { Keys } from "../src/core/keys.ts";
import { BuiltinDecider } from "../src/decide/builtin.ts";
import { parseArgs } from "../src/cli/args.ts";
import { approve, deny, describeOperation, status } from "../src/cli/commands.ts";
import { script, testGateway, untilDone } from "./helpers.ts";

// `portrail approve` / `portrail deny`: the terminal answers through daemon.json's token.
async function daemonForThisProcess() {
  const ctx = testGateway({ approvalTimeoutMs: 5000, decider: new BuiltinDecider({ allow: [], deny: [], ask: ["exec:*"] }) });
  const home = mkdtempSync(join(tmpdir(), "portrail-cli-"));
  const localToken = "cli-test-token";
  const app = await createApp({ gateway: ctx.gateway, store: ctx.store, keys: new Keys(ctx.store), dataDir: home, extension: null, localToken, agentStatus: async () => [] });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ url, pid: process.pid, startedAt: new Date().toISOString(), localToken }));
  const logs: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => logs.push(parts.join(" "));
  return { ...ctx, home, app, logs, close: async () => { console.log = original; await app.close(); await ctx.gateway.shutdown(); } };
}

test("portrail approve answers the one waiting operation; deny refuses a named one; both are once", async () => {
  const d = await daemonForThisProcess();
  const args = (...argv: string[]) => parseArgs([...argv, "--home", d.home]);

  assert.equal(await approve(args("approve")), 1, "nothing waiting → exit 1");
  assert.match(d.logs.at(-1)!, /Nothing is waiting/);

  const run = d.gateway.createRun({ workspace: "work", agent: "fake", prompt: script([{ exec: "terraform apply" }]) });
  await new Promise<void>((resolve) => d.gateway.on("event", (e) => e.runId === run.id && e.type === "approval.requested" && resolve()));
  assert.equal(await status(args("status")), 0);
  assert.match(d.logs.at(-1)!, /waiting for your answer:[\s\S]*\$ terraform apply[\s\S]*portrail approve op_/);

  assert.equal(await approve(args("approve")), 0, "exactly one waiting → answered without naming it");
  assert.match(d.logs.at(-1)!, /Allowed once: \$ terraform apply/);
  await untilDone(d.gateway, run.id);
  assert.equal(d.gateway.run(run.id).state, "succeeded");
  assert.equal(d.gateway.listOperations({ runId: run.id })[0]?.decidedBy?.startsWith("local:"), true);

  const second = d.gateway.createRun({ workspace: "work", agent: "fake", prompt: script([{ exec: "rm -rf build" }]) });
  await new Promise<void>((resolve) => d.gateway.on("event", (e) => e.runId === second.id && e.type === "approval.requested" && resolve()));
  const id = d.gateway.listOperations({ runId: second.id, state: "pending" })[0]!.id;
  assert.equal(await deny(args("deny", id)), 0);
  assert.match(d.logs.at(-1)!, /Refused once: \$ rm -rf build/);
  await untilDone(d.gateway, second.id);
  assert.equal(d.gateway.run(second.id).operations?.denied, 1);
  await assert.rejects(deny(args("deny", id)), /not waiting/);
  await d.close();
});

test("describeOperation says what the agent asked for, per kind", () => {
  assert.equal(describeOperation({ kind: "exec", command: "make deploy", cwd: "/w" }), "$ make deploy   (in /w)");
  assert.equal(describeOperation({ kind: "write", changes: [{ path: "a.ts", change: "update" }, { path: "b.ts", change: "delete" }] }), "write a.ts, delete b.ts");
  assert.equal(describeOperation({ kind: "read", paths: ["x"] }), "read x");
  assert.equal(describeOperation({ kind: "net", host: "example.com" }), "network access to example.com");
  assert.equal(describeOperation({ kind: "tool", server: "gh", tool: "issue" }), "tool gh/issue");
});
