import { id as newId, now } from "../../store/index.ts";
import type {
  Provider,
  ProviderHandle,
  ProviderStatus,
  RunContext,
  RunOutcome,
} from "../types.ts";
import type { Operation } from "../../types.ts";

/**
 * A scripted agent. The prompt is a JSON array of steps:
 *
 *   {"text":"..."}            emit text
 *   {"exec":"npm test"}       ask to run a command
 *   {"write":"src/a.ts"}      ask to change a file
 *   {"read":"src/a.ts"}       ask to read a file
 *   {"net":"example.com"}     ask for the network
 *   {"sleep":50}              wait (ms)
 *   {"hang":true}             wait until cancelled
 *   {"crash":"reason"}        die mid-run, as a real agent process might
 *   {"fail":"reason"}         finish with a failure
 *
 * Anything that is not valid JSON is treated as {"text": prompt}. Every step that
 * asks permission continues only if allowed; a denial is reported and the script
 * moves on, which is how a well-behaved agent handles "no".
 */
type Step =
  | { text: string }
  | { exec: string }
  | { write: string }
  | { read: string }
  | { net: string }
  | { sleep: number }
  | { hang: true }
  | { crash: string }
  | { fail: string };

export class FakeProvider implements Provider {
  readonly id = "fake" as const;

  async probe(): Promise<ProviderStatus> {
    // Nothing to check.
    return {
      id: "fake",
      installed: true,
      ready: true,
      version: "scripted",
      authMode: "none",
      detail: "Deterministic test agent. Never calls a model.",
    };
  }

  async start(context: RunContext): Promise<ProviderHandle> {
    return new FakeRun(context);
  }
}

class FakeRun implements ProviderHandle {
  private cancelled = false;
  private wake: (() => void) | null = null;
  readonly done: Promise<RunOutcome>;
  private nativeId = newId("fake");

  constructor(private readonly context: RunContext) {
    this.done = this.execute();
  }

  nativeSessionId() {
    return this.nativeId;
  }

  private async execute(): Promise<RunOutcome> {
    const { context } = this;
    if (context.nativeSessionId) this.nativeId = context.nativeSessionId;
    let steps: Step[];
    try {
      const parsed = JSON.parse(context.prompt);
      steps = Array.isArray(parsed) ? parsed : [{ text: context.prompt }];
    } catch {
      steps = [{ text: context.prompt }];
    }

    context.emit({ type: "started", nativeSessionId: this.nativeId });
    let denied = 0;

    for (const step of steps) {
      if (this.cancelled) return { state: "cancelled", summary: "Cancelled." };
      const base = {
        id: newId("op"),
        sessionId: context.sessionId,
        runId: context.runId,
        workspaceId: context.workspace.id,
        agent: "fake" as const,
        requestedAt: now(),
      };

      if ("text" in step) {
        context.emit({ type: "text", text: step.text });
      } else if ("sleep" in step) {
        await this.wait(step.sleep);
      } else if ("hang" in step) {
        await this.wait(Number.MAX_SAFE_INTEGER);
        return { state: "cancelled", summary: "Cancelled while hanging." };
      } else if ("crash" in step) {
        throw new Error(step.crash);
      } else if ("fail" in step) {
        return { state: "failed", summary: step.fail };
      } else {
        const operation: Operation =
          "exec" in step
            ? { ...base, kind: "exec", command: step.exec, cwd: context.workspace.root }
            : "write" in step
              ? {
                  ...base,
                  kind: "write",
                  changes: [{ path: step.write, change: "update" }],
                }
              : "read" in step
                ? { ...base, kind: "read", paths: [step.read] }
                : { ...base, kind: "net", host: step.net };
        const decision = await context.decide(operation);
        if (decision.verdict === "allow") {
          if (operation.kind === "exec") {
            context.emit({
              type: "command.started",
              opId: operation.id,
              command: operation.command,
              cwd: operation.cwd,
            });
            context.emit({
              type: "command.output",
              opId: operation.id,
              text: `ran: ${operation.command}\n`,
            });
            context.emit({ type: "command.finished", opId: operation.id, exitCode: 0 });
          } else if (operation.kind === "write") {
            context.emit({ type: "files.changed", changes: operation.changes });
          }
          context.emit({ type: "text", text: `[${operation.kind} ok] ` });
        } else {
          denied++;
          context.emit({
            type: "text",
            text: `[${operation.kind} refused: ${decision.reason}] `,
          });
        }
      }
    }
    context.emit({ type: "usage", inputTokens: 10, outputTokens: 20, costUsd: 0 });
    return {
      state: "succeeded",
      summary: denied
        ? `Done with ${denied} refusal${denied === 1 ? "" : "s"}.`
        : "Done.",
    };
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, 2 ** 31 - 1));
      timer.unref();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async interrupt() {
    this.cancelled = true;
    this.wake?.();
  }

  async steer(text: string) {
    this.context.emit({ type: "text", text: `[steered: ${text}] ` });
  }

  close() {
    this.cancelled = true;
    this.wake?.();
  }
}
