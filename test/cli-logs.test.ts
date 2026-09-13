import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { logs } from "../src/cli/commands.ts";
import { Store } from "../src/store/index.ts";
import { dataDirectory, ensurePrivateDirectory } from "../src/store/paths.ts";
import { databasePath } from "../src/daemon.ts";

test("portrail logs prints only the newest runs it was asked for", async () => {
  const home = ensurePrivateDirectory(
    dataDirectory(mkdtempSync(join(tmpdir(), "portrail-logs-"))),
  );
  const store = new Store(databasePath(home));
  store.put("workspace", {
    id: "ws",
    name: "work",
    root: home,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.put("session", {
    id: "s1",
    workspaceId: "ws",
    agent: "fake",
    state: "closed",
    nativeSessionId: null,
    lastEventSeq: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    keyId: null,
  });
  for (let i = 0; i < 30; i++)
    store.put("run", {
      id: `run_${String(i).padStart(2, "0")}`,
      sessionId: "s1",
      prompt: `prompt ${i}`,
      state: "succeeded",
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      operationIds: [],
    });
  store.close();

  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    assert.equal(
      await logs(parseArgs(["logs", "--limit", "5", "--json", "--home", home])),
      0,
    );
  } finally {
    console.log = original;
  }
  const printed = JSON.parse(lines.join("\n")) as { items: Array<{ id: string }> };
  assert.deepEqual(
    printed.items.map((run) => run.id),
    ["run_29", "run_28", "run_27", "run_26", "run_25"],
  );
});
