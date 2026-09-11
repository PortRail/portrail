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
  const op = toolToOperation("Bash", { command: "npm test", description: "run tests" }, base, root);
  assert.equal(op?.kind, "exec");
  if (op?.kind === "exec") {
    assert.equal(op.command, "npm test");
    assert.equal(op.cwd, root);
    assert.equal(op.reason, "run tests");
  }
});

test("Write and Edit become write operations; Edit carries a readable diff", () => {
  const write = toolToOperation("Write", { file_path: "/work/a.ts", content: "x" }, base, root);
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
  assert.equal(toolToOperation("Read", { file_path: "/work/x" }, base, root)?.kind, "read");
  assert.equal(toolToOperation("Grep", { pattern: "x" }, base, root)?.kind, "read");
  const fetch = toolToOperation("WebFetch", { url: "https://example.com/p" }, base, root);
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
