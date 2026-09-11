import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFeatures, REFUSED_FEATURES } from "../src/providers/codex/features.ts";

test("only features the runtime knows, has on, and has not removed are disabled", () => {
  const report = reconcileFeatures([
    { name: "apps", enabled: true, stage: "stable" },
    { name: "plugins", enabled: false, stage: "stable" },
    { name: "js_repl", enabled: false, stage: "removed" },
    { name: "shell_tool", enabled: true, stage: "stable" },
    { name: "unified_exec", enabled: true, stage: "stable" },
  ]);
  assert.deepEqual(report.disable, ["apps"], "off-by-default and removed names are never passed");
  assert.deepEqual(report.missing, []);
});

test("a runtime without the execution features is reported, not silently accepted", () => {
  const report = reconcileFeatures([{ name: "shell_tool", enabled: false, stage: "stable" }]);
  assert.deepEqual(report.missing, ["shell_tool", "unified_exec"]);
});

test("the execution host is never on the refused list", () => {
  // In 0.147 `code_mode_host` is what every command runs through. Refusing it
  // silently removes the agent's ability to do anything. Guard against re-adding it.
  assert.ok(!(REFUSED_FEATURES as readonly string[]).includes("code_mode_host"));
  assert.ok(!(REFUSED_FEATURES as readonly string[]).includes("shell_tool"));
  assert.ok(!(REFUSED_FEATURES as readonly string[]).includes("unified_exec"));
});
