import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holdsGitCredentials } from "../src/core/protected.ts";
import { containOperation } from "../src/core/gateway.ts";
import { BuiltinDecider } from "../src/decide/builtin.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Operation } from "../src/types.ts";

const limit = 64 * 1024;
const padding = (bytes: number) => "#" + " ".repeat(bytes - 2) + "\n";
const credential =
  '[remote "origin"]\n url = https://SYNTHETIC_TOKEN@example.test/repo.git\n';
const base = {
  id: "op",
  runId: "run",
  sessionId: "session",
  workspaceId: "ws",
  agent: "codex" as const,
  requestedAt: "",
};

for (const bytes of [limit - 1, limit, limit + 1]) {
  test(`a benign git config of ${bytes} bytes is judged only when completely read`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "portrail-config-boundary-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "config");
    writeFileSync(path, padding(bytes));
    assert.equal(holdsGitCredentials(path, ".git/config"), bytes > limit);
  });
}

for (const offset of [limit - 256, limit - 8, limit]) {
  test(`a git credential starting at byte ${offset} is protected`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "portrail-config-token-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "config");
    for (const suffix of [
      credential,
      '[http "https://example.test/"]\n extraheader = AUTHORIZATION: basic U1lOVEhFVElD\n',
    ]) {
      writeFileSync(path, padding(offset) + suffix);
      assert.equal(holdsGitCredentials(path, ".git/config"), true);
    }
  });
}

for (const relative of [
  ".git/config.worktree",
  ".git/worktrees/topic/config.worktree",
  ".git/modules/lib/config.worktree",
  ".git/modules/lib/worktrees/topic/config.worktree",
]) {
  test(`${relative} protects direct access and searches without blocking a benign search`, async (t) => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), "portrail-worktree-config-")),
    );
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[core]\n bare = false\n");
    const context = {
      workspaceRoot: root,
      priorDecisions: [],
      keyId: null,
      keyPolicy: null,
    };
    const search: Operation = {
      ...base,
      kind: "exec",
      command: "grep -r SYNTHETIC_TOKEN .",
      cwd: root,
    };
    const deciders = [
      new BuiltinDecider(DEFAULT_CONFIG.decide),
      new BuiltinDecider({ allow: ["exec:*", "read:**"], deny: [] }),
    ];
    for (const decider of deciders)
      assert.equal((await decider.decide(search, context)).verdict, "allow");
    for (const operation of [
      { ...base, kind: "read", paths: [relative] },
      { ...base, kind: "write", changes: [{ path: relative, change: "update" }] },
      { ...base, kind: "exec", command: `cat ${relative}`, cwd: root },
    ] as Operation[])
      assert.match(
        containOperation(operation, root).refused ?? "",
        /protected in every workspace/,
      );
    symlinkSync(path, join(root, "alias.txt"));
    assert.match(
      containOperation(
        { ...base, kind: "exec", command: "cat alias.txt", cwd: root },
        root,
      ).refused ?? "",
      /protected in every workspace/,
    );
    writeFileSync(path, credential);
    assert.equal(holdsGitCredentials(path, relative), true);
    for (const decider of deciders) {
      assert.equal((await decider.decide(search, context)).verdict, "deny");
      assert.equal(
        (
          await decider.decide(
            { ...base, kind: "read", paths: [root], recursive: true },
            context,
          )
        ).verdict,
        "deny",
      );
    }
  });
}

test("git still reads its worktree configuration for ordinary status commands", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "portrail-git-status-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: root });
  writeFileSync(join(root, ".git", "config.worktree"), credential);
  assert.match(
    execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8",
    }),
    /SYNTHETIC_TOKEN/,
  );
  assert.equal(
    containOperation(
      { ...base, kind: "exec", command: "git status --short", cwd: root },
      root,
    ).refused,
    null,
  );
  assert.equal(
    execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    "",
  );
});
