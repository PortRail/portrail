import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, BOOLEAN_FLAGS } from "../src/cli/args.ts";
import { start, type StartDeps } from "../src/cli/commands.ts";
import { startDaemon } from "../src/daemon.ts";

const args = (...argv: string[]) => parseArgs(argv, { booleans: BOOLEAN_FLAGS });
const deps = (overrides: Partial<StartDeps>): StartDeps => ({
  startDaemon: (options) => startDaemon({ ...options, noExtension: true }),
  openTunnel: () => Promise.reject(new Error("no tunnels in tests")),
  waitForDns: async () => true,
  ...overrides,
});

test("start refuses an unknown tunnel kind before starting anything", async () => {
  let started = 0;
  const home = mkdtempSync(join(tmpdir(), "portrail-start-"));
  await assert.rejects(
    start(args("start", "--tunnel", "bogus", "--home", home, "--port", "0"), deps({ startDaemon: async () => (started++, {} as never) })),
    /Unknown tunnel "bogus"/,
  );
  assert.equal(started, 0);
  assert.ok(!existsSync(join(home, "daemon.lock")));
});

test("a tunnel that fails to open closes the daemon and leaves no lock behind", async () => {
  const home = mkdtempSync(join(tmpdir(), "portrail-start-"));
  await assert.rejects(
    start(args("start", "--tunnel", "cloudflare", "--home", home, "--port", "0", "--with-fake-agent"), deps({ openTunnel: () => Promise.reject(new Error("cloudflared is not installed")) })),
    /not installed/,
  );
  assert.ok(!existsSync(join(home, "daemon.lock")), "the lock was released");
  assert.ok(!existsSync(join(home, "daemon.json")));
});
