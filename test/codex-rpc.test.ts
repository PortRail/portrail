import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexRpc, NativeError } from "../src/providers/codex/rpc.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
const spawnFake = (mode = "normal", extra: Partial<ConstructorParameters<typeof CodexRpc>[0]> = {}) =>
  new CodexRpc({
    executable: process.execPath,
    args: [fixture],
    env: { ...process.env, FAKE_MODE: mode },
    defaultTimeoutMs: 2000,
    ...extra,
  });

test("responses split mid-character and coalesced messages both arrive intact", async () => {
  const rpc = spawnFake();
  rpc.on("fault", () => {});
  const notes: unknown[] = [];
  rpc.on("notification", (m) => notes.push(m.params));

  const echoed = await rpc.call<{ text: string }>("echo", {});
  assert.equal(echoed.text, "héllo → wörld ✓");

  const coalesced = await rpc.call<{ ok: boolean }>("coalesced", {});
  assert.equal(coalesced.ok, true);
  assert.deepEqual(notes, [{ n: 1 }]);
  rpc.close(true);
});

test("a request from the agent is surfaced and our answer is relayed back", async () => {
  const rpc = spawnFake();
  rpc.on("fault", () => {});
  rpc.on("request", (m) => {
    assert.equal(m.method, "item/commandExecution/requestApproval");
    rpc.respond(m.id, { decision: "accept" });
  });
  const relayed = await rpc.call<{ clientSaid: unknown }>("ask-me", {});
  assert.deepEqual(relayed.clientSaid, { decision: "accept" });
  rpc.close(true);
});

test("a native error is typed and carries its code", async () => {
  const rpc = spawnFake();
  rpc.on("fault", () => {});
  await assert.rejects(rpc.call("native-error", {}), (error: unknown) => {
    assert.ok(error instanceof NativeError);
    assert.equal(error.nativeCode, -32600);
    return true;
  });
  rpc.close(true);
});

test("an unanswered call times out with the method name in the message", async () => {
  const rpc = spawnFake();
  rpc.on("fault", () => {});
  await assert.rejects(rpc.call("never-answer", {}, 100), /never-answer.*100 ms/);
  rpc.close(true);
});

test("process exit rejects everything still pending and reports the exit", async () => {
  const rpc = spawnFake();
  rpc.on("fault", () => {});
  const pending = rpc.call("never-answer", {}, 5000);
  const exited = new Promise((resolve) => rpc.once("exit", resolve));
  rpc.notify("die");
  await exited;
  await assert.rejects(pending, /exited/);
  assert.equal(rpc.closed, true);
});

for (const [mode, expected] of [
  ["garbage", /cannot parse/],
  ["oversized", /over the .* limit/],
  ["truncated", /ended mid-message/],
] as const) {
  test(`${mode} output faults the connection instead of delivering half a message`, async () => {
    const rpc = spawnFake(mode, { maxLineBytes: 1024 * 1024 });
    const fault = await new Promise<Error>((resolve) => rpc.once("fault", resolve));
    assert.match(fault.message, expected);
    rpc.close(true);
  });
}
