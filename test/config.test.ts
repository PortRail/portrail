import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  REACH_LIMIT_BOUNDS,
  RUN_MAX_SECONDS,
  validateConfig,
} from "../src/config.ts";
import { parsePatterns } from "../src/decide/match.ts";

test("the shipped defaults are internally valid", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  assert.doesNotThrow(() => parsePatterns(DEFAULT_CONFIG.decide.allow));
  assert.doesNotThrow(() => parsePatterns(DEFAULT_CONFIG.decide.deny));
});

test("partial config merges onto the defaults", () => {
  const merged = validateConfig({ listen: { port: 9000 } });
  assert.equal(merged.listen.port, 9000);
  assert.equal(merged.listen.host, DEFAULT_CONFIG.listen.host);
  assert.equal(merged.run.maxSeconds, DEFAULT_CONFIG.run.maxSeconds);
});

test("bad values are refused with a message naming the field", () => {
  assert.throws(() => validateConfig({ listen: { port: 0 } }), /listen.port/);
  assert.throws(() => validateConfig({ defaultAgent: "gpt" }), /defaultAgent/);
  assert.throws(() => validateConfig({ run: { maxSeconds: 5 } }), /run.maxSeconds/);
  assert.throws(() => validateConfig({ decide: { allow: [7] } }), /decide.allow/);
  assert.throws(() => validateConfig("nope"), /JSON object/);
});

test("TLS needs both halves or neither", () => {
  assert.throws(() => validateConfig({ tls: { cert: "/a.pem", key: null } }), /both/);
  assert.doesNotThrow(() => validateConfig({ tls: { cert: "/a.pem", key: "/a.key" } }));
});

test("the run time limit has the same bounds in the config as on the API", () => {
  assert.throws(
    () => validateConfig({ run: { maxSeconds: 20_000 } }),
    /run\.maxSeconds/,
  );
  assert.throws(() => validateConfig({ run: { maxSeconds: 29 } }), /run\.maxSeconds/);
  assert.equal(validateConfig({ run: { maxSeconds: 14_400 } }).run.maxSeconds, 14_400);
  assert.deepEqual(RUN_MAX_SECONDS, { min: 30, max: 14_400 });
});

test("the search reach limit has bounds, and a config without one keeps the default", () => {
  assert.equal(
    validateConfig({ decide: { allow: [] } }).decide.reachLimit,
    DEFAULT_CONFIG.decide.reachLimit,
  );
  assert.equal(validateConfig({ decide: { reachLimit: 500 } }).decide.reachLimit, 500);
  assert.throws(
    () => validateConfig({ decide: { reachLimit: 10 } }),
    /decide\.reachLimit/,
  );
  assert.throws(
    () => validateConfig({ decide: { reachLimit: REACH_LIMIT_BOUNDS.max + 1 } }),
    /decide\.reachLimit/,
  );
  assert.throws(
    () => validateConfig({ decide: { reachLimit: 1.5 } }),
    /decide\.reachLimit/,
  );
});
