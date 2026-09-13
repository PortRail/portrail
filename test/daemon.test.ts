import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.ts";
import { script } from "./helpers.ts";

const home = () => mkdtempSync(join(tmpdir(), "portrail-daemon-"));
const boot = (h: string, extra: Record<string, unknown> = {}) => startDaemon({ home: h, port: 0, fake: true, noExtension: true, ...extra });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a second start on the same data directory is refused before it touches the first daemon's runs", async () => {
  const h = home();
  const first = await boot(h);
  first.gateway.addWorkspace({ name: "work", root: mkdtempSync(join(tmpdir(), "portrail-ws-")) });
  const run = first.gateway.createRun({ workspace: "work", agent: "fake", prompt: script([{ hang: true }]) });
  for (let i = 0; i < 50 && first.gateway.run(run.id).state !== "running"; i++) await settle(10);
  assert.equal(first.gateway.run(run.id).state, "running");

  await assert.rejects(boot(h), /already running/);
  assert.equal(first.gateway.run(run.id).state, "running", "the refused start did not recover over the live daemon");
  assert.equal(first.gateway.session(run.sessionId).state, "open");
  await first.close();
  assert.ok(!existsSync(join(h, "daemon.lock")), "the lock goes with the daemon that held it");
  assert.ok(!existsSync(join(h, "daemon.json")));
});

test("a start that cannot listen leaves neither lock nor daemon.json behind", async () => {
  const h = home();
  const blocker = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => blocker.once("listening", resolve));
  const port = (blocker.address() as { port: number }).port;
  await assert.rejects(boot(h, { port }), /EADDRINUSE/);
  assert.ok(!existsSync(join(h, "daemon.lock")));
  assert.ok(!existsSync(join(h, "daemon.json")));
  blocker.close();
  const again = await boot(h);
  assert.match(again.url, /^http:\/\/127\.0\.0\.1:\d+$/, "the url names the port that was actually bound");
  assert.notEqual(again.url, "http://127.0.0.1:0");
  await again.close();
});
