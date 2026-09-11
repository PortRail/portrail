import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, digest, equal, Store } from "../src/store/index.ts";

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
  assert.throws(
    () => store.tx((): any => Promise.resolve(1)),
    /synchronous/,
  );
  store.close();
});
