import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPath,
  containOperation,
  protectedPaths,
  refuseWorkspaceRoot,
} from "../src/core/gateway.ts";
import { globToRegExp } from "../src/decide/match.ts";
import { BuiltinDecider } from "../src/decide/builtin.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ExecOperation, Operation, ReadOperation } from "../src/types.ts";

const base = {
  id: "op",
  sessionId: "s",
  runId: "r",
  workspaceId: "w",
  agent: "codex" as const,
  requestedAt: "",
};
const realTmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test("a dangling symlink pointing outside the workspace is refused, and a symlink alias is judged by its real path", () => {
  const root = realTmp("ws-");
  const outside = realTmp("outside-");
  symlinkSync(join(outside, "victim.txt"), join(root, "escape.txt")); // dangling: victim.txt does not exist
  const write: Operation = {
    ...base,
    kind: "write",
    changes: [{ path: "escape.txt", change: "add" }],
  };
  assert.match(containOperation(write, root).refused ?? "", /outside the workspace/);

  // A symlink alias for .git inside the workspace: containment passes, but the decider
  // must see the real ".git/…" path so the deny glob fires.
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  symlinkSync(join(root, ".git"), join(root, "hooksesc"));
  const hook: Operation = {
    ...base,
    kind: "write",
    changes: [{ path: "hooksesc/hooks/pre-commit", change: "add" }],
  };
  const contained = containOperation(hook, root);
  assert.equal(contained.refused, null);
  assert.match(
    (contained.operation as any).changes[0].path,
    /\/\.git\/hooks\/pre-commit$/,
    "canonical path substituted",
  );
  const canonical = canonicalPath(root, "hooksesc/hooks/pre-commit");
  assert.ok(canonical.endsWith("/.git/hooks/pre-commit"));
});

{
  // On a case-insensitive filesystem the agent may spell a path any way it likes;
  // what it opens is the file on disk, and that spelling is what the rules must see.
  const root = realTmp("ws-");
  mkdirSync(join(root, "Sub"));
  writeFileSync(join(root, "Sub", "File.txt"), "");
  const caseInsensitive = existsSync(join(root, "SUB"));
  test(
    "a path is judged by its spelling on disk",
    { skip: !caseInsensitive && "case-sensitive filesystem" },
    () => {
      const read: Operation = {
        ...base,
        kind: "read",
        paths: [join(root, "sub", "file.txt")],
      };
      const contained = containOperation(read, root.toUpperCase());
      assert.equal(contained.refused, null);
      const spelled = (contained.operation as ReadOperation).paths[0]!;
      assert.ok(spelled.endsWith("/Sub/File.txt"), spelled);
      assert.equal(contained.root, realpathSync.native(root));
    },
  );
}

test("rules ignore case, because the filesystem the commands run on does", () => {
  assert.ok(globToRegExp(".env*", true).test(".ENV.local"));
  assert.ok(globToRegExp("**/*.pem", true).test("certs/SERVER.PEM"));
  assert.ok(
    globToRegExp("npm test*", false).test("NPM TEST"),
    "commands too: `CAT .ENV` opens .env",
  );
});

test("an operation that declares nothing is refused, except a read which means the workspace root", async () => {
  const empty = new BuiltinDecider({ allow: [], deny: [] });
  const ctx = { keyId: null, keyPolicy: null, workspaceRoot: "/w", priorDecisions: [] };
  assert.equal(
    (await empty.decide({ ...base, kind: "write", changes: [] }, ctx)).verdict,
    "deny",
  );
  assert.equal(
    (await empty.decide({ ...base, kind: "read", paths: [] }, ctx)).verdict,
    "deny",
    "no allow rule at all",
  );
  const permissive = new BuiltinDecider(DEFAULT_CONFIG.decide);
  assert.equal(
    (await permissive.decide({ ...base, kind: "read", paths: [] }, ctx)).verdict,
    "allow",
    "TodoWrite-style reads still work",
  );
  const root = realTmp("ws-");
  assert.match(
    containOperation({ ...base, kind: "write", changes: [] }, root).refused ?? "",
    /no files declared/,
  );
  assert.match(
    containOperation({ ...base, kind: "exec", command: "   ", cwd: root }, root)
      .refused ?? "",
    /empty command/,
  );
});

test("home, root, and anything holding Portrail's own data cannot be a workspace", () => {
  assert.match(refuseWorkspaceRoot("/") ?? "", /root/);
  assert.match(refuseWorkspaceRoot(homedir()) ?? "", /home directory/);
  const data = realTmp("portrail-home-");
  const parent = join(data, "..");
  assert.match(refuseWorkspaceRoot(parent, data) ?? "", /protected directory/);
  const project = realTmp("project-");
  assert.equal(refuseWorkspaceRoot(project, data), null, "an ordinary folder is fine");
  const withDot = realTmp("dot-");
  mkdirSync(join(withDot, ".portrail"));
  assert.match(refuseWorkspaceRoot(withDot) ?? "", /\.portrail/);
  for (const system of [
    "/usr",
    "/etc",
    "/usr/local",
    "/private/etc",
    "/System/Library",
    "/opt",
    "/bin",
  ])
    assert.match(refuseWorkspaceRoot(system) ?? "", /system directory/, system);
});

test("credential stores, tool logins and shell history are protected everywhere", () => {
  const home = homedir();
  const list = protectedPaths();
  // Compare real paths: on some machines an entry like ~/.azure is itself a symlink.
  const real = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  };
  for (const entry of [
    ".claude.json",
    ".zsh_history",
    ".bash_history",
    ".config/gh",
    ".config/gcloud",
    ".azure",
    ".git-credentials",
    ".gitconfig",
  ])
    assert.ok(list.includes(real(join(home, entry))), `${entry} is protected`);
  const root = realTmp("ws-");
  const exec = (command: string) =>
    containOperation({ ...base, kind: "exec", command, cwd: root }, root).refused ?? "";
  assert.match(exec("cat ~/.claude.json"), /protected everywhere/);
  assert.match(exec(`tail -50 ${join(home, ".zsh_history")}`), /protected everywhere/);
  assert.match(exec("cat ~/.config/gh/hosts.yml"), /protected everywhere/);
});

test("containment itself refuses an environment assignment that could change a command, so no decider can allow it", () => {
  const root = realTmp("ws-");
  const exec = (command: string) =>
    containOperation({ ...base, kind: "exec", command, cwd: root }, root).refused;
  for (const command of [
    "NODE_OPTIONS=--require=./hook.cjs npm test",
    "env FOO=1 npm test",
    "PATH=/x npm test",
    "env -S 'npm test'",
  ])
    assert.match(exec(command) ?? "", /environment assignment|options to env/, command);
  for (const command of ["CI=1 npm test", "env CI=1 npm test", "npm test"])
    assert.equal(exec(command), null, command);
});

test("even inside an enrolled workspace, the agent's own config and secrets are off limits", () => {
  // Simulate a broad enrolment by pretending home is the root; protected paths still refuse.
  const root = homedir();
  const op: Operation = {
    ...base,
    kind: "write",
    changes: [{ path: ".ssh/authorized_keys", change: "add" }],
  };
  assert.match(containOperation(op, root).refused ?? "", /protected directory/);
  const rc: Operation = { ...base, kind: "read", paths: [".zshrc"] };
  assert.match(containOperation(rc, root).refused ?? "", /protected directory/);
});

test("'publish' inside a commit message is fine; running arbitrary package scripts is not", async () => {
  const decider = new BuiltinDecider(DEFAULT_CONFIG.decide);
  const ctx = { keyId: null, keyPolicy: null, workspaceRoot: "/w", priorDecisions: [] };
  const exec = (command: string): Operation => ({
    ...base,
    kind: "exec",
    command,
    cwd: "/w",
  });
  assert.equal(
    (await decider.decide(exec('git commit -m "publish notes"'), ctx)).verdict,
    "allow",
  );
  assert.equal((await decider.decide(exec("npm publish"), ctx)).verdict, "deny");
  assert.equal(
    (await decider.decide(exec("npm run deploy"), ctx)).verdict,
    "deny",
    "only named safe scripts",
  );
  assert.equal((await decider.decide(exec("npm run build"), ctx)).verdict, "allow");
  assert.equal(
    (await decider.decide(exec("node evil.js"), ctx)).verdict,
    "deny",
    "node <file> is not auto-allowed",
  );
  assert.equal((await decider.decide(exec("node --test"), ctx)).verdict, "allow");
});

test("read-only compound commands of the kind Codex composes pass the free defaults, and an environment assignment does not", async () => {
  const decider = new BuiltinDecider(DEFAULT_CONFIG.decide);
  const ctx = { keyId: null, keyPolicy: null, workspaceRoot: "/w", priorDecisions: [] };
  for (const command of [
    "sed -n '1,240p' src/cli/args.ts && rg --files test | sort | head -20",
    "which -a node; command -v fnm || true; command -v mise || true",
    "CI=1 NODE_ENV=test npm test",
    "git status --short && git diff -- test/args.test.ts",
  ])
    assert.equal(
      (await decider.decide({ ...base, kind: "exec", command, cwd: "/w" }, ctx))
        .verdict,
      "allow",
      command,
    );
  // A variable that changes what a command does is not a prefix to ignore.
  for (const command of [
    "PATH=/x/bin:/usr/bin npm test",
    "NODE_OPTIONS=--require=./evil.js tsc --version",
    "FOO=1 npm test",
    "GIT_CONFIG_COUNT=1 git status",
  ]) {
    const decision = await decider.decide(
      { ...base, kind: "exec", command, cwd: "/w" },
      ctx,
    );
    assert.equal(decision.verdict, "deny", command);
    assert.match(decision.reason, /environment assignment/);
  }
});

test("every path a command names must lie inside the workspace, judged by its real path", () => {
  const root = realTmp("ws-");
  const outside = realTmp("outside-");
  const home = homedir();
  mkdirSync(join(root, "src", "bin"), { recursive: true });
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "src", "bin", "cli.ts"), "");
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(outside, "victim.txt"), "secret");
  symlinkSync(join(outside, "victim.txt"), join(root, "escape.txt"));
  symlinkSync(join(home, ".ssh"), join(root, "sub", "link-to-ssh"));
  const contain = (command: string, cwd = root) =>
    containOperation({ ...base, kind: "exec", command, cwd }, root);
  const refused = (command: string, cwd = root) => contain(command, cwd).refused ?? "";

  for (const command of [
    "cat /etc/passwd",
    "ls ~/Documents",
    `npm test --prefix ${outside}`,
    "sort -o/tmp/x README.md",
    "git log --output=/tmp/x",
    "cat ../../etc/passwd",
    "cat escape.txt",
  ])
    assert.match(refused(command), /outside the workspace/, command);
  // A directory that holds protected places is refused for holding them, whichever check sees it first.
  for (const command of [
    "grep -r X ~",
    `rg -uuu X ${home}`,
    "find ~ -name config",
    "ls -la /",
  ])
    assert.match(
      refused(command),
      /outside the workspace|protected everywhere/,
      command,
    );
  for (const command of [
    "diff ~/.zsh_history ~/.bash_history",
    "cat ~/.config/gh/hosts.yml",
    "cat sub/link-to-ssh/id_rsa",
  ])
    assert.match(refused(command), /protected everywhere/, command);

  for (const command of [
    "rg -n '/api/v1' src",
    "sed -n '/^import/,/^$/p' src/a.ts",
    "cat src/bin/cli.ts",
    "/usr/bin/env node --version",
    "cat README.md | head -50",
    'git commit -m "fix: handle ../x in paths"',
    "head -c 16 /dev/urandom",
    "echo https://github.com/x/y",
    "git diff HEAD~1..HEAD -- src",
    "npm test -- test/a.test.ts",
    "tsc -p tsconfig.json",
    "wc -l README.md",
  ])
    assert.equal(contain(command).refused, null, command);
  assert.equal(
    contain("ls ..", join(root, "sub")).refused,
    null,
    "the parent of a subdirectory is still the workspace",
  );
  assert.equal(contain("cat ../README.md", join(root, "sub")).refused, null);

  // The files a command names travel with the operation, canonical, so the rules can judge them as reads.
  const named = contain("cat README.md src/bin/cli.ts nonexistent")
    .operation as ExecOperation;
  assert.deepEqual(
    named.paths?.sort(),
    [join(root, "README.md"), join(root, "src", "bin", "cli.ts")]
      .map((p) => realpathSync.native(p))
      .sort(),
  );
});

test("a command's working directory and the paths in its arguments are held against the protected list", async () => {
  const { containOperation } = await import("../src/core/gateway.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir, homedir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "portrail-exec-"));
  const exec = (command: string, cwd = root) =>
    containOperation({ ...base, kind: "exec", command, cwd }, root);
  assert.equal(exec("ls").refused, null);
  assert.equal(
    exec("ls", root + "/sub").refused,
    null,
    "a subdirectory that does not exist yet is still inside",
  );
  assert.match(
    exec("ls", homedir()).refused ?? "",
    /working directory .*outside the workspace/,
  );
  assert.match(
    exec("cat config", join(homedir(), ".ssh")).refused ?? "",
    /working directory/,
  );
  for (const command of [
    "cat ~/.ssh/id_rsa",
    "cat ~/.codex/auth.json",
    "cat ~/.claude/settings.json",
    "cat ~/.portrail/daemon.json",
    `head -c 100 ${homedir()}/.aws/credentials`,
    "cat --file=~/.ssh/config",
    "ls ~/.gnupg",
    "cat <~/.zshrc",
  ])
    assert.match(exec(command).refused ?? "", /protected everywhere/, command);
  assert.equal(exec("cat README.md && ls ./src").refused, null);
  // A relative path that climbs out of the workspace is resolved, not trusted.
  const { mkdirSync } = await import("node:fs");
  const inHome = mkdtempSync(join(homedir(), "portrail-ws-"));
  mkdirSync(join(inHome, "src"));
  assert.match(
    containOperation(
      { ...base, kind: "exec", command: "cat src/../../.zshrc", cwd: inHome },
      inHome,
    ).refused ?? "",
    /protected everywhere/,
  );
  // What no rule can judge is refused here, before any decider sees it.
  assert.match(exec("cat $HOME/.ssh/id_rsa").refused ?? "", /variable expansion/);
  assert.match(exec("ls src/*").refused ?? "", /shell glob/);
});
