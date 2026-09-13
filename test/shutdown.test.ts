import { test } from "node:test";
import assert from "node:assert/strict";
import { shutdownOnce } from "../src/cli/shutdown.ts";

test("the shutdown sequence runs once however many signals arrive, and exits with the first code", async () => {
  let closed = 0;
  const exits: number[] = [];
  const stop = shutdownOnce(async () => { closed++; }, (code) => exits.push(code), { hardExitMs: 10_000 });
  stop(1);
  stop(0);
  stop(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.deepEqual(exits, [1]);
});

test("a close that hangs still exits after the grace period", async () => {
  const exits: number[] = [];
  const stop = shutdownOnce(() => new Promise(() => {}), (code) => exits.push(code), { hardExitMs: 20 });
  stop(0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(exits, [0]);
});

test("a close that fails still exits, with a failure code", async () => {
  const exits: number[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
  try {
    const stop = shutdownOnce(async () => { throw new Error("disk gone"); }, (code) => exits.push(code), { hardExitMs: 10_000 });
    stop(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    console.error = original;
  }
  assert.deepEqual(exits, [1]);
  assert.ok(errors.some((line) => line.includes("disk gone")));
});
