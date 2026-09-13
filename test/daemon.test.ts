import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, databasePath, startDaemon } from "../src/daemon.ts";
import { Store } from "../src/store/index.ts";
import { dataDirectory, ensurePrivateDirectory } from "../src/store/paths.ts";
import { daysAgo, script, seedSession, untilDone } from "./helpers.ts";

const home = () => mkdtempSync(join(tmpdir(), "portrail-daemon-"));
const boot = (h: string, extra: Record<string, unknown> = {}) =>
  startDaemon({ home: h, port: 0, fake: true, noExtension: true, ...extra });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a second start on the same data directory is refused before it touches the first daemon's runs", async () => {
  const h = home();
  const first = await boot(h);
  first.gateway.addWorkspace({
    name: "work",
    root: mkdtempSync(join(tmpdir(), "portrail-ws-")),
  });
  const run = first.gateway.createRun({
    workspace: "work",
    agent: "fake",
    prompt: script([{ hang: true }]),
  });
  for (let i = 0; i < 50 && first.gateway.run(run.id).state !== "running"; i++)
    await settle(10);
  assert.equal(first.gateway.run(run.id).state, "running");

  await assert.rejects(boot(h), /already running/);
  assert.equal(
    first.gateway.run(run.id).state,
    "running",
    "the refused start did not recover over the live daemon",
  );
  assert.equal(first.gateway.session(run.sessionId).state, "open");
  await first.close();
  assert.ok(
    !existsSync(join(h, "daemon.lock")),
    "the lock goes with the daemon that held it",
  );
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
  assert.match(
    again.url,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    "the url names the port that was actually bound",
  );
  assert.notEqual(again.url, "http://127.0.0.1:0");
  await again.close();
});

test("an extension whose event listener throws is reported on stderr and the run still completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portrail-ext-"));
  writeFileSync(
    join(dir, "ext.mjs"),
    `export default { name: "boom", version: "0", onEvent() { throw new Error("pro bug"); } };`,
  );
  const previous = process.env.PORTRAIL_EXTENSION;
  process.env.PORTRAIL_EXTENSION = join(dir, "ext.mjs");
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
  try {
    const daemon = await assemble({ home: home(), fake: true });
    daemon.gateway.addWorkspace({
      name: "work",
      root: mkdtempSync(join(tmpdir(), "portrail-ws-")),
    });
    const run = daemon.gateway.createRun({
      workspace: "work",
      agent: "fake",
      prompt: script([{ text: "hi" }]),
    });
    await untilDone(daemon.gateway, run.id);
    assert.equal(daemon.gateway.run(run.id).state, "succeeded");
    assert.ok(
      errors.some((line) => /boom.*onEvent.*pro bug/.test(line)),
      errors.join("\n"),
    );
    await daemon.close();
  } finally {
    console.error = original;
    if (previous === undefined) delete process.env.PORTRAIL_EXTENSION;
    else process.env.PORTRAIL_EXTENSION = previous;
  }
});

/** A home whose database already holds one session that is long past the retention window. */
function homeWithOldSession() {
  const h = home();
  const store = new Store(databasePath(ensurePrivateDirectory(dataDirectory(h))));
  seedSession(store, "old", daysAgo(40), "succeeded");
  store.close();
  return h;
}

function withExtension<T>(source: string, body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "portrail-ext-"));
  writeFileSync(join(dir, "ext.mjs"), source);
  const previous = process.env.PORTRAIL_EXTENSION;
  process.env.PORTRAIL_EXTENSION = join(dir, "ext.mjs");
  return body().finally(() => {
    if (previous === undefined) delete process.env.PORTRAIL_EXTENSION;
    else process.env.PORTRAIL_EXTENSION = previous;
  });
}

test("assemble prunes what is past the retention window before it listens", async () => {
  const daemon = await assemble({
    home: homeWithOldSession(),
    fake: true,
    noExtension: true,
  });
  try {
    assert.equal(daemon.store.get("session", "old"), undefined);
    assert.equal(daemon.store.count("run", { sessionId: "old" }), 0);
    assert.equal(daemon.store.events("old").length, 0);
  } finally {
    await daemon.close();
  }
});

test("an extension is told the retention cutoff at start, and its failure is reported, not fatal", async () => {
  await withExtension(
    `export default { name: "sweeper", version: "0", onRetention(cutoff, host) { host.store.put("swept", { id: "last", cutoff }); } };`,
    async () => {
      const daemon = await assemble({ home: homeWithOldSession(), fake: true });
      try {
        const swept = daemon.store.get<{ id: string; cutoff: string }>("swept", "last");
        assert.ok(swept, "the extension ran with the host");
        assert.ok(
          swept.cutoff > daysAgo(31) && swept.cutoff < daysAgo(29),
          swept.cutoff,
        );
        assert.equal(daemon.store.get("session", "old"), undefined);
      } finally {
        await daemon.close();
      }
    },
  );

  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
  try {
    await withExtension(
      `export default { name: "sweeper", version: "0", onRetention() { throw new Error("pro bug"); } };`,
      async () => {
        const daemon = await assemble({ home: homeWithOldSession(), fake: true });
        await daemon.close();
      },
    );
  } finally {
    console.error = original;
  }
  assert.ok(
    errors.some((line) => /sweeper: onRetention failed.*pro bug/.test(line)),
    errors.join("\n"),
  );
});
