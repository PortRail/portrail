import { test } from "node:test";
import assert from "node:assert/strict";
import { GOVERNED_TOOLS, toolToOperation } from "../src/providers/claude/tools.ts";

const base = {
  id: "op_1",
  sessionId: "s1",
  runId: "r1",
  workspaceId: "w1",
  agent: "claude" as const,
  requestedAt: "2026-09-10T00:00:00.000Z",
};
const root = "/work";

test("Bash becomes an exec operation carrying the exact command", () => {
  const op = toolToOperation(
    "Bash",
    { command: "npm test", description: "run tests" },
    base,
    root,
  );
  assert.equal(op?.kind, "exec");
  if (op?.kind === "exec") {
    assert.equal(op.command, "npm test");
    assert.equal(op.cwd, root);
    assert.equal(op.reason, "run tests");
  }
});

test("Write and Edit become write operations; Edit carries a readable diff", () => {
  const write = toolToOperation(
    "Write",
    { file_path: "/work/a.ts", content: "x" },
    base,
    root,
  );
  assert.equal(write?.kind, "write");
  if (write?.kind === "write") assert.equal(write.changes[0]?.path, "/work/a.ts");

  const edit = toolToOperation(
    "Edit",
    { file_path: "/work/a.ts", old_string: "foo", new_string: "bar" },
    base,
    root,
  );
  assert.equal(edit?.kind, "write");
  if (edit?.kind === "write") {
    assert.match(edit.changes[0]?.diff ?? "", /-foo/);
    assert.match(edit.changes[0]?.diff ?? "", /\+bar/);
  }
});

test("reads, web access and MCP tools map to their own kinds", () => {
  assert.equal(
    toolToOperation("Read", { file_path: "/work/x" }, base, root)?.kind,
    "read",
  );
  assert.equal(toolToOperation("Grep", { pattern: "x" }, base, root)?.kind, "read");
  const fetch = toolToOperation(
    "WebFetch",
    { url: "https://example.com/p" },
    base,
    root,
  );
  assert.equal(fetch?.kind, "net");
  if (fetch?.kind === "net") assert.equal(fetch.host, "example.com");
  const mcp = toolToOperation("mcp__github__create_issue", { title: "t" }, base, root);
  assert.equal(mcp?.kind, "tool");
  if (mcp?.kind === "tool") {
    assert.equal(mcp.server, "github");
    assert.equal(mcp.tool, "create_issue");
  }
});

test("an unknown tool maps to nothing, which the provider turns into a refusal", () => {
  assert.equal(toolToOperation("Agent", { prompt: "go" }, base, root), null);
  assert.equal(toolToOperation("SomethingNew", {}, base, root), null);
});

test("the governed tool list never includes subagents or task tools", () => {
  for (const forbidden of ["Agent", "Task", "TaskCreate", "Skill", "Workflow"])
    assert.ok(!GOVERNED_TOOLS.includes(forbidden), `${forbidden} must not be offered`);
  assert.ok(GOVERNED_TOOLS.includes("Bash"));
  assert.ok(GOVERNED_TOOLS.includes("Edit"));
});

test("a Grep is a search over a directory, and a Glob pattern that points somewhere is judged as that place", () => {
  const grep = toolToOperation("Grep", { pattern: "x" }, base, root);
  assert.equal(grep?.kind, "read");
  if (grep?.kind === "read") {
    assert.equal(
      grep.recursive,
      true,
      "every file beneath the searched directory may be read",
    );
    assert.deepEqual(grep.paths, [root]);
  }
  const scoped = toolToOperation(
    "Grep",
    { pattern: "x", path: "/work/src" },
    base,
    root,
  );
  if (scoped?.kind === "read") assert.deepEqual(scoped.paths, ["/work/src"]);

  const anywhere = toolToOperation("Glob", { pattern: "**/*.ts" }, base, root);
  if (anywhere?.kind === "read") {
    assert.deepEqual(anywhere.paths, [root]);
    assert.ok(!anywhere.recursive, "Glob lists names, it does not read content");
  }
  const absolute = toolToOperation("Glob", { pattern: "/etc/*" }, base, root);
  if (absolute?.kind === "read")
    assert.ok(absolute.paths.includes("/etc"), absolute.paths.join(","));
  const climbing = toolToOperation("Glob", { pattern: "../x/**" }, base, root);
  if (climbing?.kind === "read")
    assert.ok(climbing.paths.includes("/x"), climbing.paths.join(","));
});

test("a Grep's glob and type travel with the read, so only files it opens are judged", () => {
  const withGlob = toolToOperation(
    "Grep",
    { pattern: "x", glob: "*.{ts,tsx}" },
    base,
    root,
  );
  if (withGlob?.kind === "read") {
    assert.deepEqual(withGlob.filter?.globs, [
      { pattern: "*.{ts,tsx}", exclude: false, dialect: "rg" },
    ]);
    assert.equal(withGlob.filter?.unmatched, "drop");
  } else assert.fail("Grep maps to a read");
  const excluding = toolToOperation(
    "Grep",
    { pattern: "x", glob: "!*.test.ts" },
    base,
    root,
  );
  if (excluding?.kind === "read") {
    assert.deepEqual(excluding.filter?.globs, [
      { pattern: "*.test.ts", exclude: true, dialect: "rg" },
    ]);
    assert.equal(excluding.filter?.unmatched, "keep");
  }
  const typed = toolToOperation("Grep", { pattern: "x", type: "py" }, base, root);
  if (typed?.kind === "read")
    assert.deepEqual(typed.filter, { globs: [], types: ["py"], unmatched: "keep" });
  const plain = toolToOperation("Grep", { pattern: "x" }, base, root);
  if (plain?.kind === "read") assert.equal(plain.filter, undefined);
});
