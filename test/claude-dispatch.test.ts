import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider } from "../src/providers/claude/index.ts";
import { GOVERNED_TOOLS } from "../src/providers/claude/tools.ts";
import type { ProviderEvent, RunContext } from "../src/providers/types.ts";
import type { Decision, Operation } from "../src/types.ts";

// The Claude provider's wiring, driven by a stand-in for the SDK's query().
// The PreToolUse hook is the gate, canUseTool is a tripwire, the init assertion
// refuses a widened tool surface, and the options that keep the gate honest are
// pinned. No inference, no real Claude.

interface Captured {
  options: any;
  prompt: string;
}

function fakeSdk(script: (captured: Captured, emit: (message: any) => void) => Promise<void>) {
  const captured: Captured[] = [];
  const query = (input: { prompt: string; options: any }) => {
    const entry: Captured = { options: input.options, prompt: input.prompt };
    captured.push(entry);
    const queue: any[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const emit = (message: any) => {
      queue.push(message);
      wake?.();
    };
    void script(entry, emit).then(() => {
      ended = true;
      wake?.();
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      },
      interrupt: async () => {
        emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted" });
        ended = true;
        wake?.();
      },
      close: () => {
        ended = true;
        wake?.();
      },
    };
    return stream as any;
  };
  return { query, captured };
}

function harness(sdk: { query: any }, decide: (operation: Operation) => Decision | Promise<Decision>) {
  const root = mkdtempSync(join(tmpdir(), "portrail-ws-"));
  const provider = new ClaudeProvider({ sdk, maxBudgetUsd: 2.5 });
  const events: ProviderEvent[] = [];
  const asked: Operation[] = [];
  const abort = new AbortController();
  const context: RunContext = {
    sessionId: "ses_test",
    runId: "run_test",
    workspace: { id: "ws_test", name: "work", root, createdAt: new Date().toISOString() },
    prompt: "do the thing",
    maxSeconds: 30,
    signal: abort.signal,
    emit: (event) => events.push(event),
    decide: async (operation) => {
      asked.push(operation);
      return decide(operation);
    },
  };
  return { provider, context, events, asked, abort, root };
}

const init = (extra: Partial<any> = {}) => ({ type: "system", subtype: "init", session_id: "claude-ses-1", tools: [...GOVERNED_TOOLS], mcp_servers: [], ...extra });

test("the PreToolUse hook is the gate — every tool call is decided by the gateway and answered in the SDK's shape", async () => {
  const hookAnswers: any[] = [];
  const sdk = fakeSdk(async (captured, emit) => {
    emit(init());
    const hook = captured.options.hooks.PreToolUse[0].hooks[0];
    const ask = (tool_name: string, tool_input: unknown, tool_use_id: string) =>
      hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id, session_id: "claude-ses-1" });
    hookAnswers.push(await ask("Bash", { command: "npm test" }, "tu_1"));
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }] } });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] }, tool_use_result: { stdout: "1 passing\n", stderr: "" } });
    hookAnswers.push(await ask("Write", { file_path: join(captured.options.cwd, "notes.md"), content: "hi" }, "tu_2"));
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }] }, tool_use_result: { filePath: join(captured.options.cwd, "notes.md") } });
    hookAnswers.push(await ask("Bash", { command: "cat ~/.ssh/id_rsa" }, "tu_3"));
    hookAnswers.push(await ask("WebFetch", { url: "https://example.com" }, "tu_4"));
    hookAnswers.push(await ask("SomethingNew", { x: 1 }, "tu_5"));
    // Anything that reaches canUseTool bypassed the hook; the only safe answer is no.
    hookAnswers.push(await captured.options.canUseTool("Bash", { command: "ls" }));
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "All done." } } });
    emit({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
  });
  const h = harness(sdk, (operation) => {
    if (operation.kind === "exec" && operation.command.includes("id_rsa")) return { verdict: "deny", reason: "secrets" };
    if (operation.kind === "net") return { verdict: "deny", reason: "no network" };
    return { verdict: "allow", reason: "fine", scope: "session" };
  });

  const handle = await h.provider.start(h.context);
  const outcome = await handle.done;
  assert.equal(outcome.state, "succeeded");
  assert.equal(handle.nativeSessionId(), "claude-ses-1");

  // What the gateway was asked — including the second Bash, which a session-scoped
  // cache must never short-circuit.
  assert.deepEqual(
    h.asked.map((op) => (op.kind === "exec" ? `exec:${op.command}` : op.kind === "write" ? `write:${op.changes.map((c) => c.path).join(",")}` : op.kind)),
    ["exec:npm test", `write:${join(h.root, "notes.md")}`, "exec:cat ~/.ssh/id_rsa", "net"],
  );

  // What the SDK received.
  assert.deepEqual(
    hookAnswers.map((answer) => answer.hookSpecificOutput?.permissionDecision ?? answer.behavior),
    ["allow", "allow", "deny", "deny", "deny", "deny"],
  );
  assert.match(hookAnswers[4].hookSpecificOutput.permissionDecisionReason, /not one Portrail can govern/);
  assert.match(hookAnswers[5].message, /permission hook did not see "Bash"/);

  // Streamed events.
  const types = h.events.map((event) => event.type);
  assert.equal(types[0], "started");
  for (const expected of ["command.started", "command.output", "command.finished", "files.changed", "text", "usage"] as const) assert.ok(types.includes(expected), `emits ${expected}`);
  const usage = h.events.find((event) => event.type === "usage");
  assert.equal(usage?.type === "usage" ? usage.costUsd : null, 0.01);

  // The options that keep the gate honest.
  const options = sdk.captured[0]!.options;
  assert.deepEqual(options.settingSources, [], "a user settings file must never load");
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.permissionMode, "default");
  assert.deepEqual(options.allowedTools, [], "a bare name here would shadow the hook");
  assert.deepEqual(options.tools, GOVERNED_TOOLS);
  assert.equal(options.maxBudgetUsd, 2.5);
  assert.equal(options.cwd, h.root);
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.failIfUnavailable, true, "no sandbox means no run, unless the operator opts out");
  assert.equal(typeof options.stderr, "function", "a degraded sandbox is surfaced, not swallowed");
  for (const secret of ["**/.codex/**", "**/.claude/**", "**/.claude.json", "**/.portrail/**", "**/.ssh/**", "**/.envrc", "**/.config/gh/**", "**/.zsh_history"]) assert.ok(options.sandbox.filesystem.denyRead.includes(secret), secret);
  assert.equal(options.sandbox.autoAllowBashIfSandboxed, false);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(options.sandbox.filesystem.allowWrite, [h.root]);
  assert.equal(options.hooks.PreToolUse[0].timeout, 3600, "approvals wait on people");
  assert.ok(!("env" in options) && !("ANTHROPIC_API_KEY" in options), "the SDK falls back to the user's own login");
  assert.equal(sdk.captured[0]!.prompt, "do the thing");
});

test("a Claude that starts with a tool Portrail did not ask for is stopped at init", async () => {
  const sdk = fakeSdk(async (_captured, emit) => {
    emit(init({ tools: [...GOVERNED_TOOLS, "mcp__github__create_issue"], mcp_servers: [{ name: "github", status: "connected" }] }));
    emit({ type: "result", subtype: "success", is_error: false, result: "should not matter" });
  });
  const h = harness(sdk, () => ({ verdict: "allow", reason: "" }));
  const handle = await h.provider.start(h.context);
  const outcome = await handle.done;
  assert.equal(outcome.state, "failed");
  assert.match(outcome.summary, /did not ask for \(mcp__github__create_issue, mcp:github\)/);
  assert.ok(!h.events.some((event) => event.type === "started"), "never reported as started");
});

test("a second run in the same session resumes the SDK session, and steering is refused honestly", async () => {
  const sdk = fakeSdk(async (_captured, emit) => {
    emit(init());
    emit({ type: "result", subtype: "success", is_error: false, result: "ok" });
  });
  const h = harness(sdk, () => ({ verdict: "allow", reason: "" }));
  const handle = await h.provider.start({ ...h.context, nativeSessionId: "claude-ses-1" });
  await assert.rejects(handle.steer("faster"), /cannot be steered mid-run/);
  await handle.done;
  assert.equal(sdk.captured[0]!.options.resume, "claude-ses-1");
});

test("cancelling interrupts the SDK and ends the run as cancelled", async () => {
  const sdk = fakeSdk(async (_captured, emit) => {
    emit(init());
    await new Promise((resolve) => setTimeout(resolve, 60_000).unref()); // the interrupt ends the stream first
  });
  const h = harness(sdk, () => ({ verdict: "allow", reason: "" }));
  const handle = await h.provider.start(h.context);
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.abort.abort();
  await handle.interrupt();
  const outcome = await handle.done;
  assert.equal(outcome.state, "cancelled");
  handle.close();
});

test("the operator's read denies are enforced by the sandbox as well, translated to the workspace", async () => {
  const sdk = fakeSdk(async (_captured, emit) => {
    emit(init());
    emit({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.01 });
  });
  const root = mkdtempSync(join(tmpdir(), "portrail-ws-"));
  const provider = new ClaudeProvider({ sdk: sdk as any, denyRead: ["confidential/**", "**/*.key", ".secrets"] });
  const events: ProviderEvent[] = [];
  const abort = new AbortController();
  const handle = await provider.start({
    sessionId: "ses_test", runId: "run_test",
    workspace: { id: "ws_test", name: "work", root, createdAt: new Date().toISOString() },
    prompt: "p", maxSeconds: 30, signal: abort.signal, emit: (event) => events.push(event), decide: async () => ({ verdict: "allow", reason: "" }),
  });
  await handle.done;
  const denyRead: string[] = sdk.captured[0]!.options.sandbox.filesystem.denyRead;
  assert.ok(denyRead.includes(join(root, "confidential/**")), "a workspace-relative rule is anchored at the workspace");
  assert.ok(denyRead.includes("**/*.key"), "a rule that already matches anywhere stays as it is");
  assert.ok(denyRead.includes(join(root, ".secrets")));
  assert.ok(denyRead.includes("**/.env"), "the built-in list is still there");
});
