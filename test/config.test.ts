import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.ts";
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
