import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, digest, equal, Store } from "../src/store/index.ts";
import { Keys } from "../src/core/keys.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("canonical form is key-order independent, so digests are stable", () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
  assert.equal(canonical(undefined), "null");
  assert.equal(canonical([1, { z: 0, a: 0 }]), '[1,{"a":0,"z":0}]');
});

test("constant-time compare rejects different lengths without throwing", () => {
  assert.equal(equal("abc", "abc"), true);
  assert.equal(equal("abc", "abd"), false);
  assert.equal(equal("abc", "abcd"), false);
});

test("records round-trip and list by session", () => {
  const store = new Store(":memory:");
  store.put("session", { id: "s1", lastEventSeq: 0 });
  store.put("run", { id: "r1", sessionId: "s1", state: "queued" });
  store.put("run", { id: "r2", sessionId: "s2", state: "queued" });

  assert.equal(store.get<{ state: string }>("run", "r1")?.state, "queued");
  assert.equal(store.list("run").length, 2);
  assert.equal(store.list("run", "s1").length, 1);
  assert.equal(store.get("run", "missing"), undefined);

  store.remove("run", "r1");
  assert.equal(store.list("run").length, 1);
  store.close();
});

test("a rolled-back transaction publishes nothing and leaves no rows", async () => {
  const store = new Store(":memory:");
  store.put("session", { id: "s1", lastEventSeq: 0 });
  let published = 0;

  assert.throws(() =>
    store.tx(() => {
      store.put("run", { id: "r1", sessionId: "s1" });
      store.afterCommit(() => published++);
      throw new Error("boom");
    }),
  );

  assert.equal(store.get("run", "r1"), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, 0, "afterCommit must not fire for a rolled-back transaction");
  store.close();
});

test("a nested rollback keeps the outer transaction intact", () => {
  const store = new Store(":memory:");
  store.tx(() => {
    store.put("meta", { id: "outer" });
    try {
      store.tx(() => {
        store.put("meta", { id: "inner" });
        throw new Error("inner fails");
      });
    } catch {
      // Swallowed on purpose: the outer transaction should still commit.
    }
  });
  assert.ok(store.get("meta", "outer"));
  assert.equal(store.get("meta", "inner"), undefined);
  store.close();
});

test("events increment per session and replay from a cursor", () => {
  const store = new Store(":memory:");
  store.put("session", { id: "s1", lastEventSeq: 0 });
  store.put("session", { id: "s2", lastEventSeq: 0 });

  store.event("s1", "run.queued", { a: 1 }, "r1");
  store.event("s1", "output", { text: "hi" }, "r1");
  store.event("s2", "run.queued", {}, "r9");

  const all = store.events("s1");
  assert.deepEqual(
    all.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(all[0]?.runId, "r1");
  assert.equal(store.events("s1", 1).length, 1);
  assert.equal(store.events("s2")[0]?.seq, 1, "sequences are per session");
  assert.equal(store.earliestEvent("s1"), 1);
  assert.equal(store.earliestEvent("nobody"), null);
  store.close();
});

test("a synchronous-only transaction refuses a promise", () => {
  const store = new Store(":memory:");
  assert.throws(() => store.tx((): any => Promise.resolve(1)), /synchronous/);
  store.close();
});

const V1_SCHEMA = `
CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, data TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE INDEX records_session ON records(kind, session_id);
CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq));
CREATE TABLE commands (principal TEXT NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (principal, route, key));
PRAGMA user_version=1;`;

/** A database exactly as the first release wrote it. */
function writeFirstSchemaDatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "portrail-v1-")), "portrail.sqlite");
  const db = new DatabaseSync(path);
  db.exec(V1_SCHEMA);
  const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  const row = (
    kind: string,
    record: Record<string, unknown>,
    sessionId: string | null = null,
  ) => insert.run(kind, record.id as string, sessionId, JSON.stringify(record));
  row("session", { id: "s1", state: "open", lastEventSeq: 0 });
  row("run", { id: "r1", sessionId: "s1", state: "queued" }, "s1");
  row("run", { id: "r2", sessionId: "s1", state: "succeeded" }, "s1");
  row("operation", { id: "o1", sessionId: "s1", runId: "r1", state: "pending" }, "s1");
  row("key", { id: "k1", hash: "abc123" });
  db.close();
  return path;
}

test("a database from the first schema is upgraded in place the first time it is opened", () => {
  const path = writeFirstSchemaDatabase();
  const store = new Store(path);
  assert.equal(
    (store.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  const indexes = (
    store.db.prepare("PRAGMA index_list('records')").all() as Array<{ name: string }>
  ).map((index) => index.name);
  for (const name of [
    "records_session",
    "records_state",
    "records_run",
    "records_hash",
  ])
    assert.ok(indexes.includes(name), name);
  const columns = (
    store.db.prepare("SELECT name FROM pragma_table_xinfo('records')").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
  assert.deepEqual(columns.slice(4), ["state", "run_id", "hash"]);
  assert.deepEqual(
    store.select<{ id: string }>("run", { state: "queued" }).map((run) => run.id),
    ["r1"],
  );
  assert.equal(store.count("run", { state: "queued" }), 1);
  assert.equal(store.findOne<{ id: string }>("key", { hash: "abc123" })?.id, "k1");
  assert.deepEqual(
    store.list<{ id: string }>("run").map((run) => run.id),
    ["r1", "r2"],
    "list keeps insertion order",
  );
  store.close();
});

test("an upgraded database opened again is left as it is, and one from a newer Portrail is refused", () => {
  const path = writeFirstSchemaDatabase();
  new Store(path).close();
  const again = new Store(path);
  const indexes = again.db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='records'",
    )
    .get() as { n: number };
  assert.equal(
    Number(indexes.n),
    5,
    "primary key plus four named indexes, no duplicates",
  );
  again.put("run", { id: "r3", sessionId: "s1", state: "queued" });
  assert.equal(again.count("run", { state: "queued" }), 2);
  again.close();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version=3");
  raw.close();
  assert.throws(() => new Store(path), /newer version/);
});

test("select filters by session, state and run, pages newest first, and count never reads the rows", () => {
  const store = new Store(":memory:");
  for (let i = 0; i < 2000; i++)
    store.put("run", {
      id: `r${i}`,
      sessionId: `s${i % 10}`,
      state: i % 100 === 0 ? "queued" : "succeeded",
    });
  store.put("operation", { id: "o1", sessionId: "s1", runId: "r1", state: "pending" });
  store.put("operation", { id: "o2", sessionId: "s1", runId: "r1", state: "decided" });
  store.put("operation", {
    id: "o3",
    sessionId: "s1",
    runId: "r11",
    state: "deciding",
  });
  assert.equal(store.count("run"), 2000);
  assert.equal(store.count("run", { state: "queued" }), 20);
  assert.equal(
    store.count("run", { sessionId: "s3", state: ["queued", "succeeded"] }),
    200,
  );
  assert.deepEqual(
    store
      .select<{ id: string }>("run", { newestFirst: true, limit: 2 })
      .map((run) => run.id),
    ["r1999", "r1998"],
  );
  assert.deepEqual(
    store
      .select<{
        id: string;
      }>("run", { state: "queued", newestFirst: true, limit: 1, offset: 1 })
      .map((run) => run.id),
    ["r1800"],
  );
  assert.deepEqual(
    store
      .select<{
        id: string;
      }>("operation", { runId: "r1", state: ["pending", "deciding"] })
      .map((op) => op.id),
    ["o1"],
  );
  const page = store.page<{ id: string }>("run", { sessionId: "s0" }, 50, 150);
  assert.equal(page.total, 200);
  assert.equal(page.items.length, 50);
  assert.equal(page.items[0]?.id, "r490");
  assert.equal(store.findOne("key", { hash: "nope" }), undefined);
  store.close();
});

test("removeWhere deletes every record of one kind for a session and says how many went", () => {
  const store = new Store(":memory:");
  for (const id of ["a", "b", "c"])
    store.put("run", { id, sessionId: "s1", state: "succeeded" });
  store.put("run", { id: "d", sessionId: "s2", state: "succeeded" });
  assert.equal(store.removeWhere("run", { sessionId: "s1" }), 3);
  assert.deepEqual(
    store.list<{ id: string }>("run").map((run) => run.id),
    ["d"],
  );
  store.close();
});

test("tailEvents walks the whole event log from a row cursor, across sessions", () => {
  const store = new Store(":memory:");
  store.put("session", { id: "s1", lastEventSeq: 0 });
  store.put("session", { id: "s2", lastEventSeq: 0 });
  const start = store.latestEventRow();
  assert.equal(start, 0);
  store.event("s1", "a");
  store.event("s2", "b");
  store.event("s1", "c");
  const tail = store.tailEvents(start, 10);
  assert.deepEqual(
    tail.map((entry) => entry.event.type),
    ["a", "b", "c"],
  );
  assert.equal(store.tailEvents(tail.at(-1)!.row, 10).length, 0);
  assert.equal(store.removeEvents("s1"), 2);
  store.close();
});

test("a key is found by its hash among hundreds, and an unknown token is refused", () => {
  const store = new Store(":memory:");
  const keys = new Keys(store);
  const tokens = Array.from(
    { length: 500 },
    (_, i) => keys.create({ name: `k${i}` }).token,
  );
  const principal = keys.authenticate(tokens[250]);
  assert.equal(principal.name, "k250");
  assert.throws(() => keys.authenticate("prt_" + "x".repeat(43)), /Unknown API key/);
  store.close();
});
