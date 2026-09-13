import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionEventPacer } from "../src/server/event-pacer.ts";

test("a session may put 100 events on the wire per second; the rest wait for the window", () => {
  let now = 0;
  const pacer = new SessionEventPacer(() => now);
  let left = 150;
  let written = 0;
  const subscription = pacer.subscribe("ses", () => (left ? (left--, written++, true) : false));
  subscription.wake();
  assert.equal(written, 100);
  now = 1001;
  subscription.wake();
  assert.equal(written, 150);
  subscription.close();
  pacer.dispose();
});

test("a sink that has nothing to write consumes no allowance", () => {
  const pacer = new SessionEventPacer(() => 0);
  const idle = pacer.subscribe("ses", () => false);
  for (let i = 0; i < 5; i++) idle.wake();
  idle.close();
  let left = 100;
  let written = 0;
  const busy = pacer.subscribe("ses", () => (left ? (left--, written++, true) : false));
  busy.wake();
  assert.equal(written, 100, "idle wakes did not spend the window");
  busy.close();
  pacer.dispose();
});

test("the allowance survives disconnect and reconnect within the window", () => {
  let now = 0;
  const pacer = new SessionEventPacer(() => now);
  let written = 0;
  const first = pacer.subscribe("ses", () => (written++, true));
  first.wake();
  assert.equal(written, 100);
  first.close();
  const second = pacer.subscribe("ses", () => (written++, true));
  second.wake();
  assert.equal(written, 100, "a reconnect cannot reset an allowance already spent");
  now = 1001;
  second.wake();
  assert.equal(written, 200);
  second.close();
  pacer.dispose();
});

test("dispose clears pending timers and later wakes are no-ops", () => {
  const pacer = new SessionEventPacer(() => 0);
  const subscription = pacer.subscribe("ses", () => true);
  subscription.wake(); // fills the window and arms a timer
  pacer.dispose();
  assert.doesNotThrow(() => subscription.wake());
  assert.doesNotThrow(() => subscription.close());
});
