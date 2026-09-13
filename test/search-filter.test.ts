import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFilter, expandBraces, type Candidate } from "../src/decide/filter.ts";
import type { SearchFilter, SearchGlob } from "../src/types.ts";
import { recursiveReadOf } from "../src/decide/recursive.ts";
import { shellSplit } from "../src/providers/codex/shell.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("brace alternatives expand before matching, nested ones too, and unbalanced braces are refused", () => {
  assert.deepEqual(expandBraces("*.{ts,tsx}"), ["*.ts", "*.tsx"]);
  assert.deepEqual(expandBraces("{a,{b,c}}.js"), ["a.js", "b.js", "c.js"]);
  assert.deepEqual(expandBraces("plain.md"), ["plain.md"]);
  assert.deepEqual(expandBraces("src/{a,b}/*.{ts,js}"), [
    "src/a/*.ts",
    "src/a/*.js",
    "src/b/*.ts",
    "src/b/*.js",
  ]);
  assert.equal(expandBraces("*.{ts"), null);
  assert.equal(expandBraces("{}"), null);
  assert.equal(expandBraces("a}b"), null);
});

const rg = (pattern: string, extra: Partial<SearchGlob> = {}): SearchGlob => ({
  pattern: pattern.replace(/^!/, ""),
  exclude: pattern.startsWith("!"),
  dialect: "rg",
  ...extra,
});
const grep = (pattern: string, exclude = false): SearchGlob => ({
  pattern,
  exclude,
  dialect: "grep",
});
const filter = (
  globs: SearchGlob[],
  extra: Partial<SearchFilter> = {},
): SearchFilter => ({
  globs,
  types: [],
  unmatched: globs.some((glob) => !glob.exclude) ? "drop" : "keep",
  ...extra,
});
/** A file as the walker saw it: its name, its path from the tool's working directory, and the directories between the search root and it. */
const file = (fromCwd: string): Candidate => {
  const parts = fromCwd.split("/");
  return {
    name: parts.at(-1)!,
    fromCwd,
    dirs: parts
      .slice(0, -1)
      .map((name, index) => ({ name, rel: parts.slice(0, index + 1).join("/") })),
  };
};
const keeps = (f: SearchFilter, candidate: Candidate) => {
  const keep = compileFilter(f);
  assert.ok(keep, "the filter compiles");
  return keep!(candidate);
};

test("the last matching glob wins, as in ripgrep", () => {
  assert.equal(
    keeps(filter([rg("!.env"), rg(".env")]), file(".env")),
    true,
    "a later include reopens the file",
  );
  assert.equal(keeps(filter([rg(".env"), rg("!.env")]), file(".env")), false);
});

test("a file no glob matches is dropped once any include exists, and kept when every glob excludes", () => {
  assert.equal(keeps(filter([rg("*.ts")]), file("README.md")), false);
  assert.equal(keeps(filter([rg("*.ts")]), file("src/a.ts")), true);
  assert.equal(keeps(filter([rg("!*.ts")]), file("README.md")), true);
  assert.equal(keeps(filter([rg("!*.ts")]), file("src/a.ts")), false);
});

test("a glob without a slash matches names at any depth, and an excluded directory prunes what is under it", () => {
  assert.equal(
    keeps(filter([rg("!confidential")]), file("confidential/plan.txt")),
    false,
  );
  assert.equal(keeps(filter([rg("!confidential")]), file("src/a.ts")), true);
  assert.equal(
    keeps(filter([rg("src")]), file("src/a.ts")),
    false,
    "naming a directory does not open the files in it",
  );
  assert.equal(
    keeps(filter([rg("!core/")]), file("src/core/reach.ts")),
    false,
    "a trailing slash means directory",
  );
  assert.equal(
    keeps(filter([rg("!core/")]), file("src/core")),
    true,
    "and does not match a file of that name",
  );
});

test("a glob with a slash is anchored to the working directory", () => {
  assert.equal(keeps(filter([rg("!src/core")]), file("src/core/reach.ts")), false);
  assert.equal(
    keeps(filter([rg("core/*.ts")]), file("src/core/reach.ts")),
    false,
    "anchored, so it does not match deeper down",
  );
  assert.equal(keeps(filter([rg("src/core/*.ts")]), file("src/core/reach.ts")), true);
  const outside: Candidate = { name: "reach.ts", fromCwd: null, dirs: [] };
  assert.equal(
    keeps(filter([rg("src/core/*.ts")]), outside),
    true,
    "a file we cannot anchor is assumed opened",
  );
  assert.equal(
    keeps(filter([rg("!src/core/*.ts")]), outside),
    true,
    "and is never assumed excluded",
  );
});

test("an include may match loosely, an exclude only exactly", () => {
  assert.equal(
    keeps(filter([rg("*.TS")]), file("a.ts")),
    true,
    "an include over-matches case",
  );
  assert.equal(
    keeps(filter([rg("!.ENV")]), file(".env")),
    true,
    "an exclude does not under-match case",
  );
  assert.equal(
    keeps(filter([rg("!.ENV", { ignoreCase: true })]), file(".env")),
    false,
    "--iglob does",
  );
});

test("grep globs match the base name, an include also the path, and --exclude-dir prunes", () => {
  assert.equal(keeps(filter([grep("*.ts")]), file("src/a.ts")), true);
  assert.equal(keeps(filter([grep("*.ts")]), file("README.md")), false);
  assert.equal(
    keeps(filter([grep("src/*")]), file("src/deep/a.ts")),
    true,
    "BSD grep matches the path too, with * crossing slashes",
  );
  assert.equal(keeps(filter([grep(".env", true)]), file(".env")), false);
  assert.equal(
    keeps(filter([grep(".ENV", true)]), file(".env")),
    true,
    "grep excludes are case-sensitive",
  );
  assert.equal(
    keeps(
      filter([{ pattern: "confidential", exclude: true, dialect: "grep-dir" }]),
      file("confidential/plan.txt"),
    ),
    false,
  );
  assert.equal(
    keeps(
      filter([{ pattern: "confidential", exclude: true, dialect: "grep-dir" }]),
      file("confidential"),
    ),
    true,
  );
});

test("types narrow to the tool's own extension lists, unknown types narrow nothing, and an include glob overrides a type", () => {
  assert.equal(keeps(filter([], { types: ["ts"] }), file("src/a.ts")), true);
  assert.equal(
    keeps(filter([], { types: ["ts"] }), file("confidential/plan.txt")),
    false,
  );
  assert.equal(keeps(filter([], { types: ["ts", "md"] }), file("README.md")), true);
  assert.equal(
    keeps(filter([], { types: ["sh"] }), file(".env")),
    true,
    "sh covers .env, so it narrows nothing",
  );
  assert.equal(keeps(filter([], { types: ["nosuchtype"] }), file(".env")), true);
  assert.equal(keeps(filter([rg("*.md")], { types: ["ts"] }), file("README.md")), true);
  assert.equal(keeps(filter([rg("*.md")], { types: ["ts"] }), file("src/a.ts")), false);
});

test("a pattern Portrail cannot read disables narrowing when it includes, and is ignored when it excludes", () => {
  assert.equal(compileFilter(filter([rg("*.[ch]")])), null);
  assert.equal(compileFilter(filter([rg("a b")])), null);
  assert.equal(compileFilter(filter([rg("#x")])), null);
  assert.equal(compileFilter(filter([rg("*.{ts")])), null);
  assert.equal(
    keeps(filter([rg("!*.[ch]"), rg("*.ts")]), file("x.c")),
    false,
    "the unreadable exclude is dropped, the include still applies",
  );
  assert.equal(keeps(filter([rg("!*.[ch]")]), file("x.c")), true);
});

test("a search command's filter flags are recorded in order, with their dialect", () => {
  const cwd = mkdtempSync(join(tmpdir(), "portrail-flags-"));
  const read = (command: string) => recursiveReadOf(shellSplit(command), cwd);

  const rgFilter = read("rg -g '*.ts' --iglob '!Fixtures' -t ts foo .")!.filter!;
  assert.deepEqual(rgFilter.globs, [
    { pattern: "*.ts", exclude: false, dialect: "rg" },
    { pattern: "Fixtures", exclude: true, dialect: "rg", ignoreCase: true },
  ]);
  assert.deepEqual(rgFilter.types, ["ts"]);
  assert.equal(rgFilter.unmatched, "drop");
  assert.deepEqual(
    read("rg -g*.ts foo")!.filter!.globs,
    [{ pattern: "*.ts", exclude: false, dialect: "rg" }],
    "an attached value",
  );
  assert.deepEqual(
    read("rg --glob=*.ts foo")!.filter!.globs,
    [{ pattern: "*.ts", exclude: false, dialect: "rg" }],
    "an = value",
  );
  assert.equal(
    read("rg -g '!.env' foo")!.filter!.unmatched,
    "keep",
    "only excludes: unmatched files are still opened",
  );
  assert.deepEqual(
    read("rg --type-add 'x:*.env' -t x foo")!.filter!.types,
    [],
    "a custom type narrows nothing",
  );
  assert.deepEqual(
    read("rg -T ts foo")!.filter?.types ?? [],
    [],
    "a negated type narrows nothing either",
  );

  const grepDrop = read("grep -r --include='*.ts' --exclude=.env KEY .")!.filter!;
  assert.deepEqual(grepDrop.globs, [
    { pattern: "*.ts", exclude: false, dialect: "grep" },
    { pattern: ".env", exclude: true, dialect: "grep" },
  ]);
  assert.equal(grepDrop.unmatched, "drop");
  assert.equal(
    read("grep -r --exclude=.env --include='*.ts' KEY .")!.filter!.unmatched,
    "keep",
    "grep keeps unmatched files when the first filter excludes",
  );
  assert.deepEqual(read("grep -r --exclude-dir=confidential KEY .")!.filter!.globs, [
    { pattern: "confidential", exclude: true, dialect: "grep-dir" },
  ]);

  assert.equal(read("rg foo src")!.filter, undefined, "no filter flags, no filter");
  assert.equal(read("diff -r a b")!.filter, undefined);
});
