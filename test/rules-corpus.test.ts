import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { containOperation } from "../src/core/gateway.ts";
import { BuiltinDecider } from "../src/decide/builtin.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Operation } from "../src/types.ts";

/**
 * One workspace, many command lines, one expected verdict each: the corpus that says
 * what the built-in rules promise. Every line goes through containment and the free
 * decider exactly as a run would. Add a row for every bypass that is closed and for
 * every legitimate command that must keep working.
 */

const ws = mkdtempSync(join(tmpdir(), "portrail-corpus-"));
const outside = mkdtempSync(join(tmpdir(), "portrail-outside-"));
const HOME = homedir();
for (const dir of ["src/bin", "test", "confidential", "sub/deep", "node_modules/pkg"])
  mkdirSync(join(ws, dir), { recursive: true });
for (const [file, content] of [
  [".env", "API_KEY=synthetic"],
  [".envrc", "export TOKEN=synthetic"],
  ["confidential/plan.txt", "synthetic"],
  ["src/a.ts", ""],
  ["src/bin/cli.ts", ""],
  ["test/a.test.ts", ""],
  ["README.md", ""],
  ["package.json", "{}"],
  ["tsconfig.json", "{}"],
  ["sub/deep/x.txt", ""],
  ["node_modules/pkg/index.js", ""],
  ["node_modules/pkg/server.pem", ""],
] as const)
  writeFileSync(join(ws, file), content);
writeFileSync(join(outside, "victim.txt"), "synthetic");
symlinkSync(join(ws, ".env"), join(ws, "innocent.txt"));
symlinkSync(join(outside, "victim.txt"), join(ws, "escape.txt"));
symlinkSync(join(HOME, ".ssh"), join(ws, "sub", "link-to-ssh"));

const base = {
  id: "op",
  sessionId: "s",
  runId: "r",
  workspaceId: "w",
  agent: "codex" as const,
  requestedAt: "",
};
type Lists = typeof DEFAULT_CONFIG.decide;
const CUSTOM: Lists = {
  allow: ["read:**", "write:**", "exec:*"],
  deny: ["read:confidential/**", "exec:curl *"],
  ask: [],
};

async function judge(command: string, lists: Lists = DEFAULT_CONFIG.decide, cwd = ws) {
  const operation: Operation = { ...base, kind: "exec", command, cwd };
  const contained = containOperation(operation, ws);
  if (contained.refused)
    return { verdict: "deny" as const, reason: contained.refused, by: "containment" };
  const decision = await new BuiltinDecider(lists).decide(contained.operation, {
    keyId: null,
    keyPolicy: null,
    workspaceRoot: contained.root,
    priorDecisions: [],
  });
  return { ...decision, by: "decider" };
}

type Row = {
  command: string;
  expected: "allow" | "deny";
  reason?: RegExp;
  lists?: Lists;
  cwd?: string;
};
const allow = (command: string, extra: Partial<Row> = {}): Row => ({
  command,
  expected: "allow",
  ...extra,
});
const deny = (command: string, reason?: RegExp, extra: Partial<Row> = {}): Row => ({
  command,
  expected: "deny",
  ...(reason ? { reason } : {}),
  ...extra,
});
const sub = join(ws, "sub");

const rows: Row[] = [
  // What Codex and Claude compose every day must keep working.
  allow("sed -n '1,40p' src/a.ts"),
  allow("sed -n '/^import/,/^$/p' src/a.ts"),
  allow("rg -n foo src"),
  allow("rg -n '/api/v1' src"),
  allow("rg --files | head -20"),
  allow("rg -n 'foo|bar' -g '!node_modules' src"),
  allow("grep -n foo src/a.ts"),
  allow("grep -rn foo src"),
  allow("find src -name a.ts"),
  allow("git log --oneline -5"),
  allow("git status --short && git diff -- src/a.ts"),
  allow("git diff HEAD~1..HEAD -- src"),
  allow('git commit -m "fix: handle ../x in paths"'),
  allow("git branch --show-current"),
  allow("npm test"),
  allow("npm test -- test/a.test.ts"),
  allow("npm run test:unit"),
  allow("npm run build"),
  allow("CI=1 NODE_ENV=test npm test"),
  allow("env CI=1 npm test"),
  allow("command -v node"),
  allow("which node"),
  allow("node --version"),
  allow("node --test"),
  allow("tsc -p tsconfig.json"),
  allow("ls -la"),
  allow("ls src"),
  allow("wc -l README.md"),
  allow("diff src/a.ts README.md"),
  allow("cat README.md | head -50"),
  allow("cat src/bin/cli.ts"),
  allow("head -c 16 /dev/urandom"),
  allow("echo https://github.com/x/y"),
  allow("echo '$HOME'"),
  allow("ls ..", { cwd: sub }),
  allow("cat ../README.md", { cwd: sub }),
  allow("ls confidential", { lists: CUSTOM }),
  allow("rg foo src", { lists: CUSTOM }),

  // Outside the workspace, whatever the spelling.
  deny("cat /etc/passwd", /outside the workspace/),
  deny("ls ~/Documents", /outside the workspace/),
  deny("ls -la /", /outside the workspace|protected everywhere/),
  deny("grep -r X ~", /outside the workspace|protected everywhere/),
  deny(`rg -uuu X ${HOME}`, /outside the workspace|protected everywhere/),
  deny("find ~ -name config", /outside the workspace|protected everywhere/),
  deny(`npm test --prefix ${outside}`, /outside the workspace/),
  deny("cat escape.txt", /outside the workspace/),
  deny("cat ~/.zsh_history", /protected everywhere/),
  deny("cat ~/.config/gh/hosts.yml", /protected everywhere/),
  deny("cat ~/.claude.json", /protected everywhere/),
  deny("diff ~/.zsh_history ~/.bash_history", /protected everywhere/),
  deny("cat sub/link-to-ssh/id_rsa", /protected everywhere/),
  deny("cat ~/.SSH/ID_RSA"),
  deny("cat ~/.Aws/Credentials"),
  deny("ls; cat /Users/someone/.aws/credentials"),

  // Secret files inside the workspace, by name, alias or spelling.
  deny("cat innocent.txt", /read:\.env\*/),
  deny("cat ../.env", undefined, { cwd: sub }),
  deny("cat .ENV"),
  deny("git show HEAD:.ENV"),
  deny("cat .envrc"),
  deny("git show HEAD:.envrc"),
  deny("git log -p -- .env"),
  deny("head confidential/plan.txt", /confidential/, { lists: CUSTOM }),

  // What text cannot judge.
  deny("NODE_OPTIONS=--require=./hook.cjs npm test", /environment assignment/),
  deny("env FOO=1 npm test", /environment assignment/),
  deny("find . -name x -exec rm {} \;"),
  deny("echo hi > out.txt", /redirect/),
  deny("cat x $(rm -rf ~)", /substitution/),

  // A search over a directory is judged by what it can reach; rg hides dotfiles unless told otherwise.
  allow("rg API_KEY"),
  deny("grep -r API_KEY .", /reaches \.env/),
  deny("grep -R x .", /reaches \.env|out of the workspace/),
  deny("rg --hidden API_KEY", /reaches \.env/),
  deny("rg -uuu API_KEY .", /reaches \.env/),
  deny("grep -rn foo -- .", /reaches \.env/),
  deny("diff -r . src", /reaches \.env|out of the workspace/),
  allow("diff -r sub/deep src"),
  deny("rg foo confidential", /confidential/, { lists: CUSTOM }),

  // Read-only tools with a write or run switch, and prefix look-alikes.
  deny("sed -n 1w/tmp/x README.md", /print or filter/),
  deny("sed -n -i s/a/b/ README.md", /print or filter/),
  deny("sed -n 's/a/b/e' README.md", /print or filter/),
  deny("node --test evil.js", /No allow rule/),
  deny("node --test --import ./evil.mjs", /No allow rule|deny list/),
  deny("npm run build-and-deploy", /No allow rule/),
  deny("npm testx", /No allow rule/),
  deny("lsof -i", /No allow rule/),
  deny("git branch -D main"),
  deny("git log --output=out.txt"),
  deny("git diff --output=/tmp/x"),
  deny("sort -o out.txt README.md"),
  deny("rg --pre cat foo src"),

  // Wrappers, keywords, parentheses and program paths do not hide a denied program.
  deny("SUDO ls"),
  deny("Curl http://x"),
  deny("env curl http://x", undefined, { lists: CUSTOM }),
  deny("command -p curl http://x", undefined, { lists: CUSTOM }),
  deny("(curl http://x)", undefined, { lists: CUSTOM }),
  deny("if true; then curl http://x; fi", undefined, { lists: CUSTOM }),
  deny("/usr/bin/curl http://x", undefined, { lists: CUSTOM }),
  deny("echo x | xargs -n1 curl", undefined, { lists: CUSTOM }),
  deny("env -S 'curl http://x'", undefined, { lists: CUSTOM }),
  deny("./bin/git status", /No allow rule/),
  deny("/usr/bin/env node --version", /No allow rule/),
];

for (const row of rows)
  test(`${row.expected}: ${row.command}${row.lists ? " (custom lists)" : ""}${row.cwd ? " (from sub/)" : ""}`, async () => {
    const got = await judge(row.command, row.lists, row.cwd);
    assert.equal(got.verdict, row.expected, `${got.by}: ${got.reason}`);
    if (row.reason) assert.match(got.reason, row.reason);
  });
