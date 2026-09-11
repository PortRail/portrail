import { test } from "node:test";
import assert from "node:assert/strict";
import { shellSplit, unwrapShellCommand } from "../src/providers/codex/shell.ts";

test("Codex's login-shell wrapper is peeled so rules see what a person would type", () => {
  const cases: Array<[string, string]> = [
    ["/bin/zsh -lc 'cat greeting.txt'", "cat greeting.txt"],
    ["/bin/zsh -lc whoami", "whoami"],
    ["/bin/bash -c \"npm test -- --watch\"", "npm test -- --watch"],
    ["/bin/zsh -lc 'printf '\\''hi\\n'\\'' > x.txt && cat x.txt'", "printf 'hi\\n' > x.txt && cat x.txt"],
  ];
  for (const [raw, expected] of cases) {
    const result = unwrapShellCommand(raw);
    assert.equal(result.command, expected, raw);
    assert.ok(result.argv, "the literal invocation is kept");
  }
});

test("a bare command is passed through untouched", () => {
  assert.deepEqual(unwrapShellCommand("cat file"), { command: "cat file" });
  assert.deepEqual(unwrapShellCommand("/bin/zsh -lc"), { command: "/bin/zsh -lc" });
  assert.deepEqual(unwrapShellCommand("zsh -lc a b"), { command: "zsh -lc a b" }, "four tokens is not the wrapper");
});

test("word splitting handles quotes and escapes without ever running anything", () => {
  assert.deepEqual(shellSplit(`a "b c" 'd e' f\\ g`), ["a", "b c", "d e", "f g"]);
  assert.deepEqual(shellSplit(`echo "it's"`), ["echo", "it's"]);
  assert.deepEqual(shellSplit(`  spaced   out  `), ["spaced", "out"]);
});

test("a session-scoped allow is still sent to Codex as a one-off accept, never acceptForSession", async () => {
  const { toCodexDecision } = await import("../src/providers/codex/approvals.ts");
  assert.equal(toCodexDecision({ verdict: "allow", reason: "", scope: "session" }), "accept");
  assert.equal(toCodexDecision({ verdict: "allow", reason: "", scope: "run" }), "accept");
  assert.equal(toCodexDecision({ verdict: "allow", reason: "" }), "accept");
  assert.equal(toCodexDecision({ verdict: "deny", reason: "" }), "decline");
});
