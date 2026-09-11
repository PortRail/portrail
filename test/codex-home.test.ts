import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexEnvironment, prepareCodexHome } from "../src/providers/codex/home.ts";

function withSourceHome(fn: (source: string, data: string) => void) {
  const source = mkdtempSync(join(tmpdir(), "portrail-codex-src-"));
  const data = mkdtempSync(join(tmpdir(), "portrail-data-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = source;
  try {
    fn(source, data);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

test("a managed home has a clean config, prompt rules, and a shared login", () => {
  withSourceHome((source, data) => {
    writeFileSync(join(source, "auth.json"), '{"token":"secret"}');
    const home = prepareCodexHome(data);

    assert.equal(home.path, join(data, "codex"));
    assert.equal(home.authSource, join(source, "auth.json"));
    assert.ok(lstatSync(join(home.path, "auth.json")).isSymbolicLink());
    assert.equal(readlinkSync(join(home.path, "auth.json")), join(source, "auth.json"));

    const config = readFileSync(join(home.path, "config.toml"), "utf8");
    assert.match(config, /approval_policy = "untrusted"/);
    assert.doesNotMatch(config, /danger-full-access|notify|plugins|mcp_servers/);

    const rules = readFileSync(join(home.path, "rules", "portrail.rules"), "utf8");
    assert.match(rules, /prefix_rule\(pattern=\["cat"\], decision="prompt"\)/);
    assert.match(rules, /prefix_rule\(pattern=\["whoami"\], decision="prompt"\)/);
  });
});

test("preparing twice is idempotent and never rewrites a hand-edited file", () => {
  withSourceHome((source, data) => {
    writeFileSync(join(source, "auth.json"), "{}");
    const first = prepareCodexHome(data);
    const second = prepareCodexHome(data);
    assert.equal(first.path, second.path);

    writeFileSync(join(first.path, "config.toml"), 'model = "mine"\n');
    assert.throws(() => prepareCodexHome(data), /edited by hand/);
  });
});

test("no login file means no link, and the environment still carries API keys", () => {
  withSourceHome((_source, data) => {
    const home = prepareCodexHome(data);
    assert.equal(home.authSource, null);
    assert.ok(!existsSync(join(home.path, "auth.json")));

    const env = codexEnvironment(home);
    assert.equal(env.CODEX_HOME, home.path);
    assert.ok(!("OPENAI_API_KEY" in env) || env.OPENAI_API_KEY === process.env.OPENAI_API_KEY);
  });
});
