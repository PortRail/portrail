import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { holdsGitCredentials, isWorkspaceSecret } from "../src/core/protected.ts";
import { reachableFiles } from "../src/core/reach.ts";

function repo(files: Record<string, string>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "portrail-git-creds-")));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const carries = (text: string) => {
  const root = repo({ ".git/config": text });
  return holdsGitCredentials(join(root, ".git/config"), ".git/config");
};

test("a git config carries a credential in every form git and CI write one", () => {
  assert.equal(
    carries('[remote "origin"]\n\turl = https://user:synthetic@example.test/x.git\n'),
    true,
    "user and password in the URL",
  );
  assert.equal(
    carries('[remote "origin"]\n\turl = https://ghp_SYNTHETIC@github.com/o/r.git\n'),
    true,
    "a token used as the URL user",
  );
  assert.equal(
    carries(
      '[url "https://oauth2:synthetic@gitlab.example.test/"]\n\tinsteadOf = https://gitlab.example.test/\n',
    ),
    true,
    "a rewrite rule with a token",
  );
  assert.equal(
    carries(
      '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic U1lOVEhFVElD\n',
    ),
    true,
    "the auth header a CI checkout persists",
  );
  assert.equal(
    carries("[credential]\n\tpassword = synthetic\n"),
    true,
    "a stored password",
  );
});

test("an ordinary git config carries none", () => {
  assert.equal(
    carries(
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@example.test:x/y.git\n',
    ),
    false,
  );
  assert.equal(
    carries('[remote "origin"]\n\turl = ssh://git@example.test/x/y.git\n'),
    false,
    "an ssh user is not a secret",
  );
  assert.equal(
    carries('[remote "origin"]\n\turl = https://example.test/a@b/y.git\n'),
    false,
    "an @ in the path is not a user",
  );
});

test("a submodule's config is the workspace's credential file too", () => {
  assert.equal(isWorkspaceSecret(".git/config"), true);
  assert.equal(isWorkspaceSecret(".git/modules/lib/config"), true);
  assert.equal(isWorkspaceSecret("vendor/.git/modules/a/modules/b/config"), true);
  assert.equal(isWorkspaceSecret("src/config"), false);
  assert.equal(isWorkspaceSecret(".git/hooks/config"), false);
});

test("a search walks a submodule's git directory but never an object store", () => {
  const root = repo({
    ".git/config": "[core]\n",
    ".git/modules/lib/config": "[core]\n",
    ".git/modules/lib/objects/pack/p.pack": "x",
    ".git/objects/aa/bb": "x",
    ".git/lfs/objects/cc/dd": "x",
    "a.ts": "",
  });
  const files = reachableFiles(root, root, { hidden: true, follow: false })
    .files.map((file) => file.slice(root.length + 1))
    .sort();
  assert.deepEqual(files, [".git/config", ".git/modules/lib/config", "a.ts"]);
});
