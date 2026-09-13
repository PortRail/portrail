import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, type GatewayOptions } from "../src/core/gateway.ts";
import { BuiltinDecider } from "../src/decide/builtin.ts";
import type { Decider } from "../src/extension.ts";
import { FakeProvider } from "../src/providers/fake/index.ts";
import { Store } from "../src/store/index.ts";
import { TERMINAL_STATES, type AgentId } from "../src/types.ts";
import type { Provider } from "../src/providers/types.ts";
import type { PortrailEvent } from "../src/store/index.ts";

export const script = (steps: unknown[]) => JSON.stringify(steps);

export function testGateway(
  overrides: Partial<GatewayOptions> & { decider?: Decider; store?: Store; providers?: Map<AgentId, Provider> } = {},
) {
  const store = overrides.store ?? new Store(":memory:");
  const decider =
    overrides.decider ??
    new BuiltinDecider({
      allow: ["read:**", "write:**", "exec:npm test*", "exec:ls*"],
      deny: ["write:.env*", "exec:rm -rf*", "net:*"],
    });
  const providers = overrides.providers ?? new Map<AgentId, Provider>([["fake", new FakeProvider()]]);
  const gateway = new Gateway(store, providers, decider, {
    maxConcurrent: overrides.maxConcurrent ?? 2,
    defaultMaxSeconds: overrides.defaultMaxSeconds ?? 60,
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? 200,
    maxQueued: overrides.maxQueued ?? 10,
  });
  const root = mkdtempSync(join(tmpdir(), "portrail-gw-"));
  const workspace = gateway.addWorkspace({ name: "work", root });
  const events: PortrailEvent[] = [];
  gateway.on("event", (event: PortrailEvent) => events.push(event));
  return { gateway, store, workspace, root, events };
}

/** Resolve once the run reaches a terminal state. */
export function untilDone(gateway: Gateway, runId: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    if (TERMINAL_STATES.has(gateway.run(runId).state)) return resolve();
    const timer = setTimeout(() => reject(new Error(`run ${runId} did not finish`)), timeoutMs);
    const check = (event: PortrailEvent) => {
      if (event.runId === runId && event.type === "run.completed") {
        clearTimeout(timer);
        gateway.off("event", check);
        resolve();
      }
    };
    gateway.on("event", check);
  });
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
