import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachableFiles } from "../src/core/reach.ts";

function fixture() {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "portrail-reach-")));
  const outside = realpathSync.native(
    mkdtempSync(join(tmpdir(), "portrail-reach-outside-")),
  );
  for (const dir of ["src", "confidential", "node_modules/pkg", ".git/objects", "sub"])
    mkdirSync(join(ws, dir), { recursive: true });
  for (const file of [
    ".env",
    ".envrc",
    ".git/config",
    "src/a.ts",
    "confidential/plan.txt",
    "node_modules/pkg/server.pem",
    ".git/objects/x",
    "sub/y.txt",
    "README.md",
  ])
    writeFileSync(join(ws, file), "");
  writeFileSync(join(outside, "victim.txt"), "");
  symlinkSync(join(ws, ".env"), join(ws, "innocent.txt"));
  symlinkSync(join(outside, "victim.txt"), join(ws, "escape.txt"));
  symlinkSync(join(ws, "sub"), join(ws, "loop"));
  symlinkSync(join(ws, "loop"), join(ws, "sub", "back"));
  return { ws, outside };
}
const names = (files: string[], ws: string) =>
  files.map((f) => f.slice(ws.length + 1)).sort();

test("a walk lists what a search can reach: hidden files only when asked, object stores never", () => {
  const { ws } = fixture();
  const visible = reachableFiles(ws, ws, { hidden: false, follow: false });
  assert.deepEqual(names(visible.files, ws), [
    "README.md",
    "confidential/plan.txt",
    "src/a.ts",
    "sub/y.txt",
  ]);
  assert.equal(visible.truncated, false);
  assert.equal(visible.outside, null);
  const hidden = reachableFiles(ws, ws, { hidden: true, follow: false });
  assert.deepEqual(names(hidden.files, ws), [
    ".env",
    ".envrc",
    ".git/config",
    "README.md",
    "confidential/plan.txt",
    "src/a.ts",
    "sub/y.txt",
  ]);
  assert.ok(
    !hidden.files.some((f) => f.includes("node_modules")),
    "the dependency tree stays out of a judgement by default",
  );
  assert.ok(
    !hidden.files.some((f) => f.includes("/.git/objects/")),
    "the object store is compressed; a text search never matches inside it",
  );
});

test("the dependency tree is walked only when the caller asks, object stores never", () => {
  const { ws } = fixture();
  const all = reachableFiles(ws, ws, {
    hidden: true,
    follow: false,
    skipDependencies: false,
  });
  assert.ok(
    all.files.some((f) => f.endsWith("node_modules/pkg/server.pem")),
    "asked for, the dependency tree is walked",
  );
  assert.ok(!all.files.some((f) => f.includes("/.git/objects/")));
  assert.ok(all.files.some((f) => f.endsWith("/.git/config")));
});

test("symlinks are followed only when the tool would follow them, and a link out of the workspace is reported", () => {
  const { ws, outside } = fixture();
  const stay = reachableFiles(join(ws, "sub"), ws, { hidden: true, follow: false });
  assert.deepEqual(
    names(stay.files, ws),
    ["sub/y.txt"],
    "a symlink is not a file when links are not followed",
  );
  const followed = reachableFiles(join(ws, "sub"), ws, { hidden: true, follow: true });
  assert.deepEqual(
    names(followed.files, ws),
    ["sub/y.txt"],
    "a directory loop terminates and lists each file once",
  );
  const whole = reachableFiles(ws, ws, { hidden: true, follow: true });
  assert.equal(
    whole.outside,
    join(ws, "escape.txt"),
    "the link that leaves the workspace is named",
  );
  const alias = reachableFiles(ws, ws, { hidden: false, follow: true });
  assert.ok(
    alias.outside === join(ws, "escape.txt") || alias.files.includes(join(ws, ".env")),
    "an alias resolves to the real file, or the walk stops at the escaping link first",
  );
  void outside;
});

test("a walk stops at the limit and says so", () => {
  const { ws } = fixture();
  const capped = reachableFiles(ws, ws, { hidden: true, follow: false, limit: 3 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.files.length, 3);
});
