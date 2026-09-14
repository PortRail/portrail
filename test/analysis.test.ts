import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyseOperation } from "../src/decide/analysis.ts";
import type { Operation } from "../src/types.ts";

/**
 * The analysis says what an operation touches, in every form a rule may judge:
 * the segments of a command line, the files it names, the files a search opens.
 * It is what the built-in decider and an extension's decider both judge from.
 */

const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "portrail-analysis-")));
for (const dir of ["src", "sub/deep", "node_modules/pkg"])
  mkdirSync(join(ws, dir), { recursive: true });
for (const [file, content] of [
  [".env", "API_KEY=synthetic"],
  [".envrc", "export TOKEN=synthetic"],
  ["src/a.ts", ""],
  ["README.md", ""],
  ["sub/deep/x.txt", ""],
  ["node_modules/pkg/index.js", ""],
] as const)
  writeFileSync(join(ws, file), content);

const base = {
  id: "op",
  sessionId: "s",
  runId: "r",
  workspaceId: "w",
  agent: "codex" as const,
  requestedAt: "",
};
const exec = (command: string, extra: Partial<Operation> = {}): Operation => ({
  ...base,
  kind: "exec",
  command,
  cwd: ws,
  ...(extra as object),
});

test("a command is analysed once into its segments, in every form a rule may match", async () => {
  const analysis = await analyseOperation(exec("env curl http://x | xargs -n1 rm"), {
    workspaceRoot: ws,
  });
  assert.equal(analysis.kind, "exec");
  assert.equal(analysis.unjudgeable, null);
  assert.equal(analysis.segments.length, 2);
  const [first, second] = analysis.segments;
  assert.equal(first!.program, "curl");
  assert.equal(first!.text, "env curl http://x");
  assert.equal(first!.unwrapped, "curl http://x");
  assert.equal(first!.named, "curl http://x");
  assert.deepEqual(first!.denyForms, ["env curl http://x", "curl http://x"]);
  assert.deepEqual(first!.allowForms, ["env curl http://x", "curl http://x"]);
  assert.equal(second!.program, "rm");
  assert.equal(second!.fed, true);
  assert.ok(second!.denyForms.includes("rm <stdin>"));
  assert.deepEqual(second!.allowForms, ["xargs -n1 rm", "rm"]);
  assert.equal(first!.sedObjection, null);
});

test("what text cannot judge is reported and nothing else is analysed", async () => {
  const analysis = await analyseOperation(exec("cat x $(rm -rf ~)"), {
    workspaceRoot: ws,
  });
  assert.equal(analysis.unjudgeable, "command substitution");
  assert.deepEqual(analysis.segments, []);
  assert.deepEqual(analysis.searches, []);
});

test("the files a command names are workspace-relative", async () => {
  const analysis = await analyseOperation(
    exec("cat src/a.ts", { paths: [join(ws, "src/a.ts")] } as Partial<Operation>),
    { workspaceRoot: ws },
  );
  assert.deepEqual(analysis.namedPaths, ["src/a.ts"]);
  assert.deepEqual(analysis.paths, []);
});

test("a search is judged by the files it opens, narrowed by its filters, and refused when it cannot be bounded", async () => {
  const hidden = await analyseOperation(exec("rg --hidden KEY ."), {
    workspaceRoot: ws,
  });
  assert.equal(hidden.searches.length, 1);
  assert.equal(hidden.searches[0]!.segment, 0);
  assert.equal(hidden.searches[0]!.where, ".");
  assert.equal(hidden.searches[0]!.refused, null);
  assert.ok(hidden.searches[0]!.files.includes(".env"));
  assert.ok(hidden.searches[0]!.files.includes("src/a.ts"));
  assert.ok(!hidden.searches[0]!.files.some((file) => file.startsWith("node_modules")));

  const narrowed = await analyseOperation(exec("rg -g '*.ts' KEY ."), {
    workspaceRoot: ws,
  });
  assert.deepEqual(narrowed.searches[0]!.files, ["src/a.ts"]);

  const bounded = await analyseOperation(exec("rg --hidden a . && rg --hidden b src"), {
    workspaceRoot: ws,
    reachLimit: 1,
  });
  assert.equal(bounded.searches.length, 1, "the walk stops at the first refusal");
  assert.match(bounded.searches[0]!.refused!, /too many files/);
  assert.deepEqual(bounded.searches[0]!.files, []);
});

test("a suspect file git ignores is not reached by a tool that honours .gitignore", async () => {
  const repo = realpathSync.native(
    mkdtempSync(join(tmpdir(), "portrail-analysis-git-")),
  );
  writeFileSync(join(repo, ".env"), "SECRET=1");
  writeFileSync(join(repo, "a.ts"), "");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const suspect = (path: string) => path === ".env";

  const honoured = await analyseOperation(exec("rg --hidden KEY .", { cwd: repo }), {
    workspaceRoot: repo,
    suspect,
  });
  assert.ok(!honoured.searches[0]!.files.includes(".env"));
  assert.ok(honoured.searches[0]!.files.includes("a.ts"));

  const unsuspected = await analyseOperation(exec("rg --hidden KEY .", { cwd: repo }), {
    workspaceRoot: repo,
  });
  assert.ok(
    unsuspected.searches[0]!.files.includes(".env"),
    "only suspects are asked of git",
  );

  const ignoring = await analyseOperation(exec("grep -r KEY .", { cwd: repo }), {
    workspaceRoot: repo,
    suspect,
  });
  assert.ok(
    ignoring.searches[0]!.files.includes(".env"),
    "grep does not honour .gitignore",
  );
});

test("a recursive read reports its searches and leaves the paths alone", async () => {
  const read: Operation = {
    ...base,
    kind: "read",
    recursive: true,
    paths: [ws, join(ws, "src/a.ts")],
  };
  const analysis = await analyseOperation(read, { workspaceRoot: ws });
  assert.deepEqual(analysis.paths, [".", "src/a.ts"]);
  assert.equal(analysis.searches.length, 1);
  assert.equal(analysis.searches[0]!.segment, null);
  assert.equal(analysis.searches[0]!.where, ".");
  assert.ok(analysis.searches[0]!.files.includes(".env"));

  const filtered = await analyseOperation(
    {
      ...read,
      filter: {
        globs: [{ pattern: "*.ts", exclude: false, dialect: "rg" }],
        types: [],
        unmatched: "drop",
      },
    },
    { workspaceRoot: ws },
  );
  assert.deepEqual(filtered.searches[0]!.files, ["src/a.ts"]);
});

test("sed is checked on every segment, by the program's name", async () => {
  const piped = await analyseOperation(exec("sed -n 1p f | gsed -i s/a/b/ f"), {
    workspaceRoot: ws,
  });
  assert.equal(piped.segments[0]!.sedObjection, null);
  assert.match(piped.segments[1]!.sedObjection!, /option -i/);
  const plain = await analyseOperation(exec("cat f"), { workspaceRoot: ws });
  assert.equal(plain.segments[0]!.sedObjection, null);
  const shouted = await analyseOperation(exec("/usr/bin/SED -n 1w/tmp/x f"), {
    workspaceRoot: ws,
  });
  assert.equal(shouted.segments[0]!.program, "sed");
  assert.match(shouted.segments[0]!.sedObjection!, /script/);
  const search = await analyseOperation(exec("RG --hidden KEY ."), {
    workspaceRoot: ws,
  });
  assert.equal(search.searches.length, 1, "a capitalised rg is still a search");
});

test("net and tool operations reduce to one subject", async () => {
  const net = await analyseOperation(
    { ...base, kind: "net", host: "example.com", url: "https://example.com/x" },
    { workspaceRoot: ws },
  );
  assert.equal(net.subject, "example.com");
  assert.deepEqual(net.segments, []);
  const tool = await analyseOperation(
    { ...base, kind: "tool", server: "github", tool: "create_issue", input: {} },
    { workspaceRoot: ws },
  );
  assert.equal(tool.subject, "github/create_issue");
});
