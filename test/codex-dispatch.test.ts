import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProvider } from "../src/providers/codex/index.ts";
import type { ProviderEvent, RunContext } from "../src/providers/types.ts";
import type { Decision, Operation } from "../src/types.ts";

// The Codex provider's dispatch, driven by a scripted stand-in for the
// binary. Every request type Codex can send is answered from context.decide(), a
// withdrawn request is never answered, and the diff for a file change is joined by
// itemId. No inference, no network, no real Codex.
const fixture = fileURLToPath(new URL("./fixtures/fake-codex", import.meta.url));
chmodSync(fixture, 0o755);

function harness(
  scenario: Record<string, unknown>,
  decide: (operation: Operation) => Decision | Promise<Decision>,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "portrail-codex-"));
  const root = mkdtempSync(join(tmpdir(), "portrail-ws-"));
  writeFileSync(join(dataDir, "fake-scenario.json"), JSON.stringify(scenario));
  const provider = new CodexProvider({ executablePath: fixture, dataDir });
  const events: ProviderEvent[] = [];
  const asked: Operation[] = [];
  const abort = new AbortController();
  const context: RunContext = {
    sessionId: "ses_test",
    runId: "run_test",
    workspace: {
      id: "ws_test",
      name: "work",
      root,
      createdAt: new Date().toISOString(),
    },
    prompt: "do the thing",
    maxSeconds: 30,
    signal: abort.signal,
    emit: (event) => events.push(event),
    decide: async (operation) => {
      asked.push(operation);
      return decide(operation);
    },
  };
  const log = () =>
    readFileSync(join(dataDir, "fake-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { provider, context, events, asked, abort, root, dataDir, log };
}

test("every Codex approval request is answered from the gateway's decision, and a withdrawn one is left alone", async () => {
  const scenario = {
    steps: [
      {
        notify: "item/started",
        params: {
          item: {
            type: "commandExecution",
            id: "item_1",
            command: "/bin/zsh -lc 'npm test'",
            cwd: "/tmp",
          },
        },
      },
      {
        request: "item/commandExecution/requestApproval",
        params: {
          itemId: "item_1",
          command: "/bin/zsh -lc 'npm test'",
          cwd: "/tmp",
          reason: "run the tests",
        },
      },
      {
        notify: "item/commandExecution/outputDelta",
        params: { itemId: "item_1", delta: "1 passing\n" },
      },
      {
        notify: "item/completed",
        params: { item: { type: "commandExecution", id: "item_1", exitCode: 0 } },
      },
      // The file-change approval carries no diff; it arrived on item/started.
      {
        notify: "item/started",
        params: {
          item: {
            type: "fileChange",
            id: "item_2",
            changes: [{ path: "notes.md", diff: "+hello", kind: { type: "add" } }],
          },
        },
      },
      {
        request: "item/fileChange/requestApproval",
        params: { itemId: "item_2", reason: "write notes" },
      },
      {
        notify: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "item_2",
            status: "completed",
            changes: [{ path: "notes.md", diff: "+hello", kind: { type: "add" } }],
          },
        },
      },
      {
        request: "item/permissions/requestApproval",
        params: {
          permissions: { network: { enabled: true } },
          reason: "fetch a package",
        },
      },
      {
        request: "item/commandExecution/requestApproval",
        params: { itemId: "item_3", command: "cat ~/.ssh/id_rsa" },
      },
      // Withdrawn before we answer: serverRequest/resolved follows immediately.
      {
        request: "item/commandExecution/requestApproval",
        params: { itemId: "item_4", command: "sleep 100" },
        withdraw: true,
      },
      { request: "mcpServer/elicitation/request", params: { message: "pick one" } },
      {
        request: "item/tool/requestUserInput",
        params: { questions: [{ id: "q1", text: "sure?" }] },
      },
      { notify: "item/agentMessage/delta", params: { delta: "All done." } },
      {
        notify: "turn/completed",
        params: { turn: { id: "turn_fake", status: "completed" } },
      },
    ],
  };
  let slowResolve: ((d: Decision) => void) | null = null;
  const h = harness(scenario, (operation) => {
    if (operation.kind === "exec" && operation.command === "sleep 100")
      return new Promise<Decision>((resolve) => (slowResolve = resolve)); // never answered by us
    if (operation.kind === "exec" && operation.command.includes("id_rsa"))
      return { verdict: "deny", reason: "secrets" };
    if (operation.kind === "net") return { verdict: "deny", reason: "no network" };
    return { verdict: "allow", reason: "fine", scope: "session" };
  });

  const handle = await h.provider.start(h.context);
  const outcome = await handle.done;
  assert.equal(outcome.state, "succeeded");

  // What the gateway was asked, in order, with the shell wrapper peeled.
  assert.deepEqual(
    h.asked.map((op) =>
      op.kind === "exec"
        ? `exec:${op.command}`
        : op.kind === "write"
          ? `write:${op.changes.map((c) => c.path).join(",")}`
          : op.kind,
    ),
    [
      "exec:npm test",
      "write:notes.md",
      "net",
      "exec:cat ~/.ssh/id_rsa",
      "exec:sleep 100",
    ],
  );
  const write = h.asked.find((op) => op.kind === "write");
  assert.equal(
    write?.kind === "write" ? write.changes[0]?.diff : null,
    "+hello",
    "the diff was joined onto the approval by itemId",
  );
  assert.equal(h.asked[0]?.reason, "run the tests");

  // What Codex received. Session scope is sent as a plain accept, never acceptForSession.
  const answered = h
    .log()
    .filter((entry) => entry.answered)
    .map((entry) => entry.answered);
  assert.deepEqual(
    answered.map((a) => [a.method, JSON.stringify(a.result)]),
    [
      ["item/commandExecution/requestApproval", '{"decision":"accept"}'],
      ["item/fileChange/requestApproval", '{"decision":"accept"}'],
      ["item/permissions/requestApproval", '{"permissions":{},"scope":"turn"}'],
      ["item/commandExecution/requestApproval", '{"decision":"decline"}'],
      ["mcpServer/elicitation/request", '{"action":"decline"}'],
      ["item/tool/requestUserInput", '{"answers":{"q1":{"answers":[]}}}'],
    ],
  );
  assert.ok(
    !h.log().some((entry) => entry.unexpectedAnswer),
    "a withdrawn request is never answered",
  );
  assert.ok(
    slowResolve,
    "the withdrawn request had reached the gateway before it was withdrawn",
  );

  // Streamed events, in the shapes the rest of Portrail consumes.
  const types = h.events.map((event) => event.type);
  assert.deepEqual(types.slice(0, 1), ["started"]);
  for (const expected of [
    "command.started",
    "command.output",
    "command.finished",
    "files.changed",
    "text",
  ] as const)
    assert.ok(types.includes(expected), `emits ${expected}`);
  const started = h.events.find((event) => event.type === "command.started");
  assert.equal(
    started?.type === "command.started" ? started.command : null,
    "npm test",
  );

  // The binary was launched in app-server mode with the managed home and an empty environment.
  const launch = h.log()[0];
  assert.deepEqual(launch.argv.slice(0, 2), ["app-server", "--stdio"]);
  assert.ok(launch.env.includes("CODEX_HOME"));
  assert.ok(!launch.env.includes("FAKE_SECRET_SHOULD_NOT_LEAK"));
  handle.close();
});

test("a Codex that cannot list its MCP servers does not get to run", async () => {
  const h = harness({ mcpListFails: true, steps: [] }, () => ({
    verdict: "allow",
    reason: "",
  }));
  await assert.rejects(
    h.provider.start(h.context),
    /could not list its MCP servers .*Refusing to run/,
  );
  assert.ok(
    !h.log().some((entry) => entry.received === "turn/start"),
    "no turn was started",
  );
});

test("a Codex with a foreign MCP server enabled is refused before the turn starts", async () => {
  const h = harness(
    { mcpServers: [{ name: "evil", tools: { shell: {} } }], steps: [] },
    () => ({ verdict: "allow", reason: "" }),
  );
  await assert.rejects(h.provider.start(h.context), /MCP servers enabled \(evil\)/);
});

test("cancelling a run interrupts the turn and ends it as cancelled", async () => {
  const h = harness(
    {
      steps: [
        {
          request: "item/commandExecution/requestApproval",
          params: { itemId: "i", command: "sleep 5" },
        },
      ],
    },
    () => new Promise(() => {}),
  );
  const handle = await h.provider.start(h.context);
  await new Promise((resolve) => setTimeout(resolve, 100));
  h.abort.abort();
  const outcome = await handle.done;
  assert.equal(outcome.state, "cancelled");
});

test("a permission request is answered only with the entries that were judged and allowed — never echoed back", async () => {
  const { homedir } = await import("node:os");
  const scenario = {
    steps: [
      // Root write + a read of ~/.ssh: an untranslatable target refuses the whole request.
      {
        request: "item/permissions/requestApproval",
        params: {
          permissions: {
            fileSystem: {
              entries: [
                { access: "write", path: { type: "special", value: { kind: "root" } } },
                { access: "read", path: { type: "path", path: `${homedir()}/.ssh` } },
              ],
            },
          },
          reason: "need it",
        },
      },
      // A plain read outside the workspace: judged, contained, refused.
      {
        request: "item/permissions/requestApproval",
        params: {
          permissions: {
            fileSystem: {
              entries: [
                { access: "read", path: { type: "path", path: `${homedir()}/.ssh` } },
              ],
            },
          },
        },
      },
      // A write inside the workspace plus a read outside it: only the write comes back.
      {
        request: "item/permissions/requestApproval",
        params: {
          permissions: {
            fileSystem: {
              entries: [
                { access: "write", path: { type: "path", path: "build" } },
                { access: "read", path: { type: "path", path: "/etc" } },
              ],
            },
          },
        },
      },
      // Network: never grantable through this channel.
      {
        request: "item/permissions/requestApproval",
        params: { permissions: { network: { enabled: true } } },
      },
      {
        notify: "turn/completed",
        params: { turn: { id: "turn_fake", status: "completed" } },
      },
    ],
  };
  // Stands in for the gateway: containment refuses anything outside the workspace, the rules allow the rest.
  const h = harness(scenario, (operation) => {
    const paths =
      operation.kind === "read"
        ? operation.paths
        : operation.kind === "write"
          ? operation.changes.map((c) => c.path)
          : [];
    if (operation.kind === "net") return { verdict: "deny", reason: "no destination" };
    if (paths.some((p) => p.startsWith("/") && !p.startsWith(h.root)))
      return { verdict: "deny", reason: "outside the workspace" };
    return { verdict: "allow", reason: "rules say yes", scope: "session" };
  });
  const handle = await h.provider.start(h.context);
  await handle.done;
  const answers = h
    .log()
    .filter((e) => e.answered)
    .map((e) => e.answered.result);
  assert.deepEqual(
    answers[0],
    { permissions: {}, scope: "turn" },
    "special target: refused before any rule",
  );
  assert.deepEqual(
    answers[1],
    { permissions: {}, scope: "turn" },
    "read outside the workspace: refused",
  );
  assert.deepEqual(
    answers[2],
    {
      permissions: {
        fileSystem: {
          entries: [{ access: "write", path: { type: "path", path: "build" } }],
        },
      },
      scope: "session",
    },
    "only the judged, allowed entry is granted",
  );
  assert.deepEqual(
    answers[3],
    { permissions: {}, scope: "turn" },
    "network is refused",
  );
  // The gateway was asked about every translatable path and nothing else.
  const kinds = h.asked.map((op) =>
    op.kind === "read"
      ? `read:${op.paths.join(",")}`
      : op.kind === "write"
        ? `write:${op.changes.map((c) => c.path).join(",")}`
        : op.kind,
  );
  assert.deepEqual(
    kinds,
    [`read:${homedir()}/.ssh`, "read:/etc", "write:build", "net"],
    "every translatable path is judged; the request with a special target never reaches the gateway at all",
  );
  assert.ok(
    h.events.some(
      (e) => e.type === "warning" && /cannot judge/.test((e as any).message),
    ),
    "the refused request is visible in the run",
  );
  handle.close();
});

test("a Codex that dies after the turn began leaves the outcome unknown, not failed", async () => {
  const h = harness(
    {
      steps: [
        { notify: "item/agentMessage/delta", params: { delta: "working…" } },
        { exit: 3 },
      ],
    },
    () => ({ verdict: "allow", reason: "" }),
  );
  const handle = await h.provider.start(h.context);
  const outcome = await handle.done;
  assert.ok(
    h.events.some((event) => event.type === "started"),
    "the turn had begun",
  );
  assert.equal(outcome.state, "outcome_unknown");
  assert.match(outcome.summary, /exited/);
});
