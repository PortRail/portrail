/**
 * Live check: does Codex, driven through the Portrail provider, actually do work?
 *
 * Uses real inference. Creates a throwaway workspace, asks the agent to create a
 * file and run a command, and records every operation it asked permission for.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "../src/providers/codex/index.ts";
import { ClaudeProvider } from "../src/providers/claude/index.ts";
import { loadConfig } from "../src/config.ts";
import { dataDirectory } from "../src/store/paths.ts";
import type { Operation, Decision } from "../src/types.ts";
import type { ProviderEvent } from "../src/providers/types.ts";

const config = loadConfig(dataDirectory());
const root = mkdtempSync(join(tmpdir(), "portrail-e2e-"));
const decisions: Array<{ operation: Operation; decision: Decision }> = [];
const events: ProviderEvent[] = [];
const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;

// Allow everything except one deliberately refused command, so we can see both paths.
async function decide(operation: Operation): Promise<Decision> {
  const refused =
    operation.kind === "exec" && /\bwhoami\b/.test(operation.command);
  const decision: Decision = refused
    ? { verdict: "deny", reason: "e2e: whoami is refused on purpose" }
    : { verdict: "allow", reason: "e2e: allowed", scope: "once" };
  decisions.push({ operation, decision });
  const label =
    operation.kind === "exec"
      ? operation.command
      : operation.kind === "write"
        ? operation.changes.map((c) => `${c.change} ${c.path}`).join(", ")
        : operation.kind;
  console.log(`${stamp()}  DECIDE  ${operation.kind.padEnd(5)} ${decision.verdict.padEnd(5)} ${label}`);
  return decision;
}

const agent = process.argv[2] ?? "codex";
const provider =
  agent === "claude"
    ? new ClaudeProvider({ executablePath: config.agents.claude.path })
    : new CodexProvider({ executablePath: config.agents.codex.path, dataDir: dataDirectory() });
console.log(`agent: ${agent}`);
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 240_000);

let text = "";
const handle = await provider.start({
  sessionId: "ses_e2e",
  runId: "run_e2e",
  workspace: { id: "ws_e2e", name: "e2e", root, createdAt: new Date().toISOString() },
  prompt:
    "Create a file named hello.txt in the current directory containing exactly the single line: hello from portrail\n" +
    "Then run `cat hello.txt` to show its contents.\n" +
    "Then run `whoami` (it may be refused; if so, just say so and stop).\n" +
    "Do not create any other files.",
  maxSeconds: 240,
  signal: abort.signal,
  decide,
  emit(event) {
    events.push(event);
    switch (event.type) {
      case "started":
        console.log(`${stamp()}  STARTED thread=${event.nativeSessionId}`);
        break;
      case "text":
        text += event.text;
        break;
      case "reasoning":
        break;
      case "command.started":
        console.log(`${stamp()}  CMD     ${event.command}`);
        break;
      case "command.finished":
        console.log(`${stamp()}  EXIT    ${event.exitCode}`);
        break;
      case "files.changed":
        console.log(`${stamp()}  FILES   ${event.changes.map((c) => `${c.change} ${c.path}`).join(", ")}`);
        break;
      case "warning":
        console.log(`${stamp()}  WARN    ${event.message}`);
        break;
      case "usage":
        console.log(`${stamp()}  USAGE   in=${event.inputTokens} out=${event.outputTokens}`);
        break;
    }
  },
});

const outcome = await handle.done;
clearTimeout(timer);

console.log(`\n${stamp()}  DONE    ${outcome.state}: ${outcome.summary}`);
console.log(`\n--- agent text ---\n${text.trim()}\n------------------`);

const target = join(root, "hello.txt");
const exists = existsSync(target);
const content = exists ? readFileSync(target, "utf8") : null;
const denied = decisions.filter((entry) => entry.decision.verdict === "deny");

// Every line below is a pass criterion; a FAIL names which one it was.
console.log(`\noutcome succeeded:  ${outcome.state === "succeeded"}`);
console.log(`file created:       ${exists}`);
console.log(`file content ok:    ${content?.trim() === "hello from portrail"}`);
console.log(`operations decided: ${decisions.length} (${decisions.filter((d) => d.operation.kind === "exec").length} exec, ${decisions.filter((d) => d.operation.kind === "write").length} write)`);
console.log(`denial observed:    ${denied.length > 0}`);
console.log(`event types seen:   ${[...new Set(events.map((event) => event.type))].join(", ")}`);

rmSync(root, { recursive: true, force: true });
const pass = outcome.state === "succeeded" && exists && content?.trim() === "hello from portrail" && decisions.length > 0 && denied.length > 0;
console.log(`\n${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
