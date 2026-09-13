import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  existsSync,
  readlinkSync,
  lstatSync,
} from "node:fs";
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
    assert.ok(
      !("OPENAI_API_KEY" in env) || env.OPENAI_API_KEY === process.env.OPENAI_API_KEY,
    );
  });
});

/** Run `fn` with console.error captured, and return what it printed. */
function stderrOf(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

/** Replace the managed link with a regular file, the way a rename-refresh through it does. */
function replaceLinkWithFile(link: string, content: string) {
  unlinkSync(link);
  writeFileSync(link, content, { mode: 0o600 });
}

const past = new Date(Date.now() - 60_000);

test("a newer token that replaced the login link is moved back to the real login and relinked", () => {
  withSourceHome((source, data) => {
    const sourceAuth = join(source, "auth.json");
    writeFileSync(sourceAuth, '{"token":"stale"}');
    const home = prepareCodexHome(data);
    const link = join(home.path, "auth.json");
    replaceLinkWithFile(link, '{"token":"fresh"}');
    utimesSync(sourceAuth, past, past);

    const lines = stderrOf(() => prepareCodexHome(data));

    assert.ok(lstatSync(link).isSymbolicLink(), "the link is back");
    assert.equal(readlinkSync(link), sourceAuth);
    assert.equal(readFileSync(sourceAuth, "utf8"), '{"token":"fresh"}');
    assert.equal(statSync(sourceAuth).mode & 0o777, 0o600);
    assert.ok(
      !readdirSync(source).some((name) => name.includes("portrail-tmp")),
      "no temporary file is left behind",
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /auth\.json/);
    assert.match(lines[0]!, /relinked/);
    assert.doesNotMatch(lines[0]!, /fresh|stale/, "the token never reaches the log");
  });
});

test("an identical or older file that replaced the login link is discarded and the link restored", () => {
  withSourceHome((source, data) => {
    const sourceAuth = join(source, "auth.json");
    writeFileSync(sourceAuth, '{"token":"real"}');
    const home = prepareCodexHome(data);
    const link = join(home.path, "auth.json");

    replaceLinkWithFile(link, '{"token":"real"}');
    stderrOf(() => prepareCodexHome(data));
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(sourceAuth, "utf8"), '{"token":"real"}');

    replaceLinkWithFile(link, '{"token":"old"}');
    utimesSync(link, past, past);
    stderrOf(() => prepareCodexHome(data));
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(
      readFileSync(sourceAuth, "utf8"),
      '{"token":"real"}',
      "an older stray never clobbers the login",
    );
  });
});

test("a file at the link with no real login behind it becomes the login", () => {
  withSourceHome((source, data) => {
    const sourceAuth = join(source, "auth.json");
    writeFileSync(sourceAuth, '{"token":"real"}');
    const home = prepareCodexHome(data);
    const link = join(home.path, "auth.json");
    replaceLinkWithFile(link, '{"token":"only-copy"}');
    rmSync(sourceAuth);

    const again = stderrOf(() => {
      const prepared = prepareCodexHome(data);
      assert.equal(prepared.authSource, sourceAuth);
    });
    assert.equal(again.length, 1);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(sourceAuth, "utf8"), '{"token":"only-copy"}');
    assert.equal(statSync(sourceAuth).mode & 0o777, 0o600);
  });
});
