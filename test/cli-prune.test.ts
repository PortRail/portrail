import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { prune } from "../src/cli/commands.ts";
import { databasePath } from "../src/daemon.ts";
import { Store } from "../src/store/index.ts";
import { dataDirectory, ensurePrivateDirectory } from "../src/store/paths.ts";
import { daysAgo, seedSession } from "./helpers.ts";

/** A home with one session and one command row well past the default window. */
function seededHome() {
  const h = mkdtempSync(join(tmpdir(), "portrail-prune-"));
  const store = new Store(databasePath(ensurePrivateDirectory(dataDirectory(h))));
  seedSession(store, "old", daysAgo(40), "succeeded");
  store.db
    .prepare(
      "INSERT INTO commands (principal, route, key, digest, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("k1", "POST /v1/runs", "old-key", "d", "{}", daysAgo(40));
  store.close();
  return h;
}

async function captured(argv: string[]) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    const code = await prune(parseArgs(["prune", ...argv]));
    return { code, text: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("portrail prune removes what is past the window, reports the counts, and does nothing the second time", async () => {
  const h = seededHome();
  const first = await captured(["--home", h, "--json"]);
  assert.equal(first.code, 0);
  const report = JSON.parse(first.text);
  assert.equal(report.days, 30);
  assert.ok(report.cutoff > daysAgo(31) && report.cutoff < daysAgo(29), report.cutoff);
  assert.deepEqual(
    {
      s: report.sessions,
      r: report.runs,
      o: report.operations,
      e: report.events,
      c: report.commands,
    },
    { s: 1, r: 1, o: 1, e: 2, c: 1 },
  );

  const second = await captured(["--home", h, "--json"]);
  assert.equal(second.code, 0);
  const again = JSON.parse(second.text);
  assert.deepEqual(
    [again.sessions, again.runs, again.operations, again.events, again.commands],
    [0, 0, 0, 0, 0],
  );
});

test("portrail prune says what it removed in plain text and honours --days", async () => {
  const h = seededHome();
  const kept = await captured(["--home", h, "--days", "60"]);
  assert.equal(kept.code, 0);
  assert.match(kept.text, /Removed 0 sessions/);
  const pruned = await captured(["--home", h, "--days", "30"]);
  assert.match(pruned.text, /Removed 1 session\b/);
  assert.match(pruned.text, /1 run\b.*1 operation\b.*2 events.*1 command\b/s);
});

test("portrail prune takes 0 to mean everything finished, and still refuses a fraction", async () => {
  const h = seededHome();
  // A session from an hour ago: inside every window a day or wider, but before now.
  const store = new Store(databasePath(dataDirectory(h)));
  seedSession(
    store,
    "recent",
    new Date(Date.now() - 3_600_000).toISOString(),
    "succeeded",
  );
  store.close();

  const window = await captured(["--home", h, "--json", "--days", "30"]);
  assert.equal(
    JSON.parse(window.text).sessions,
    1,
    "the old session goes, the one from an hour ago stays",
  );

  await assert.rejects(
    captured(["--home", h, "--days", "0"]),
    /--yes/,
    "everything is one confirmation away, not one keystroke",
  );
  const retry = seedRetry(h, new Date(Date.now() - 3_600_000).toISOString());
  const everything = await captured(["--home", h, "--json", "--days", "0", "--yes"]);
  assert.equal(JSON.parse(everything.text).sessions, 1, "0 takes what is left");
  assert.equal(
    retryRecords(h, retry),
    1,
    "a retry record from an hour ago stays, so a client retrying now is not handed a second run",
  );

  await assert.rejects(captured(["--home", h, "--days", "1.5"]), /whole number/);
  await assert.rejects(captured(["--home", h, "--days=-1"]), /0 or more/);
});

test("portrail prune gives the loaded extension the same cutoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portrail-ext-"));
  writeFileSync(
    join(dir, "ext.mjs"),
    `export default { name: "sweeper", version: "0", onRetention(cutoff, host) { host.store.put("swept", { id: "last", cutoff }); } };`,
  );
  const previous = process.env.PORTRAIL_EXTENSION;
  process.env.PORTRAIL_EXTENSION = join(dir, "ext.mjs");
  const h = seededHome();
  try {
    const result = await captured(["--home", h, "--json"]);
    assert.equal(result.code, 0);
    const store = new Store(databasePath(dataDirectory(h)));
    try {
      const swept = store.get<{ id: string; cutoff: string }>("swept", "last");
      assert.equal(swept?.cutoff, JSON.parse(result.text).cutoff);
      assert.equal(store.get("session", "old"), undefined);
    } finally {
      store.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PORTRAIL_EXTENSION;
    else process.env.PORTRAIL_EXTENSION = previous;
  }
});

function withStore<T>(home: string, work: (store: Store) => T): T {
  const store = new Store(databasePath(dataDirectory(home)));
  try {
    return work(store);
  } finally {
    store.close();
  }
}

/** An Idempotency-Key record as the API writes one: the run id and nothing else. */
function seedRetry(home: string, createdAt: string): string {
  const key = `retry-${Date.parse(createdAt)}`;
  withStore(home, (store) =>
    store.db
      .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)")
      .run(
        "key_test",
        "POST /v1/runs",
        key,
        "digest",
        JSON.stringify({ id: "run_x" }),
        createdAt,
      ),
  );
  return key;
}

function retryRecords(home: string, key: string): number {
  return withStore(home, (store) =>
    Number(
      (
        store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE key=?").get(key) as {
          n: number;
        }
      ).n,
    ),
  );
}
