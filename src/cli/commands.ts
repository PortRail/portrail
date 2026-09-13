import { userInfo } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./args.ts";
import { PortrailError } from "../contracts/errors.ts";
import { Keys, publicKey } from "../core/keys.ts";
import { Gateway } from "../core/gateway.ts";
import { BuiltinDecider } from "../decide/builtin.ts";
import { loadConfig, type PortrailConfig } from "../config.ts";
import { databasePath, runningDaemon, startDaemon } from "../daemon.ts";
import { Store } from "../store/index.ts";
import { dataDirectory, ensurePrivateDirectory } from "../store/paths.ts";
import { version } from "../runtime.ts";
import { openTunnel, waitForDns, type TunnelKind } from "../tunnel.ts";
import { installService, serviceInfo, uninstallService } from "../service.ts";
import type { OperationRecord, RunRecord } from "../core/records.ts";
import { shutdownOnce } from "./shutdown.ts";

const out = (json: boolean, value: unknown, text: () => string) =>
  console.log(json ? JSON.stringify(value, null, 2) : text());

/**
 * Open the store directly for admin commands (keys, workspaces, logs).
 *
 * Safe next to a running daemon only because the Gateway built here never calls
 * recover() — that would mark the daemon's in-flight runs unknown — and because
 * the store waits on a busy database instead of failing at once.
 */
function offline(home: string | undefined) {
  const dataDir = ensurePrivateDirectory(dataDirectory(home));
  const config = loadConfig(dataDir);
  const store = new Store(databasePath(dataDir));
  const keys = new Keys(store);
  const gateway = adminGateway(store, config, dataDir);
  return { dataDir, config, store, keys, gateway, close: () => store.close() };
}

/** A gateway with no providers: enough for workspace admin, never dispatches. */
export function adminGateway(store: Store, config: PortrailConfig, dataDir: string): Gateway {
  return new Gateway(store, new Map(), new BuiltinDecider(config.decide), {
    dataDir,
    maxConcurrent: 0,
    defaultMaxSeconds: config.run.maxSeconds,
    approvalTimeoutMs: 1,
    maxQueued: 0,
  });
}

// ---------------------------------------------------------------- start

/** Who decides: the extension when it is active, the built-in list otherwise — and why. */
function describeRules(daemon: { extension: { name: string; version: string; status?(dataDir: string): { active: boolean; detail: string } } | null; dataDir: string }): string {
  if (!daemon.extension) return "built-in allow/deny list";
  const status = daemon.extension.status?.(daemon.dataDir) ?? { active: true, detail: "" };
  const name = `${daemon.extension.name} ${daemon.extension.version}`;
  return status.active ? `${name}${status.detail ? ` (${status.detail})` : ""}` : `built-in allow/deny list — ${name} is inactive: ${status.detail}`;
}

export async function start(args: ParsedArgs): Promise<number> {
  const known = new Set(["home", "host", "port", "insecure", "with-fake-agent", "tunnel", "json"]);
  const extensionOptions: Record<string, string | boolean> = {};
  for (const [flag, value] of args.flags) if (!known.has(flag)) extensionOptions[flag] = value;
  const daemon = await startDaemon({
    home: flagString(args, "home"),
    host: flagString(args, "host"),
    port: flagNumber(args, "port"),
    insecure: flagBool(args, "insecure"),
    fake: flagBool(args, "with-fake-agent"),
    extensionOptions,
  });
  const agents = await daemon.agents();
  const ready = agents.filter((agent) => agent.ready).map((agent) => agent.id);

  let tunnel: Awaited<ReturnType<typeof openTunnel>> | null = null;
  const tunnelFlag = args.flags.get("tunnel");
  if (tunnelFlag) {
    const kind = (tunnelFlag === true ? "cloudflare" : tunnelFlag) as TunnelKind;
    process.stdout.write(`Opening ${kind} tunnel… `);
    tunnel = await openTunnel(kind, Number(new URL(daemon.url).port));
    process.stdout.write(`${tunnel.url}\nWaiting for DNS to propagate… `);
    const reachable = await waitForDns(tunnel.url, {
      onTick: (elapsed) => process.stdout.write(elapsed % 10_000 < 2000 ? "." : ""),
    });
    console.log(reachable ? "reachable." : "still not resolving after 90s — it usually appears within a minute; try again shortly.");
  }

  console.log(
    `Portrail ${version} listening on ${daemon.url}\n` +
      (tunnel ? `  public:  ${tunnel.url}  (${tunnel.kind} tunnel — API keys still required)\n` : "") +
      `  data:    ${daemon.dataDir}\n` +
      `  agents:  ${ready.length ? ready.join(", ") : "none ready — run \`portrail doctor\`"}\n` +
      `  rules:   ${describeRules(daemon)}\n` +
      (daemon.gateway.listWorkspaces().length
        ? ""
        : `  WARNING: no workspace enrolled — runs will be refused. Run \`portrail workspace add <path>\`\n`) +
      (daemon.keys.list().some((key) => !key.revokedAt)
        ? ""
        : `  WARNING: no API key — nothing can call this gateway. Run \`portrail key create local\`\n`) +
      `\nPress Ctrl+C to stop.`,
  );
  const stop = shutdownOnce(
    async () => {
      console.log("\nStopping…");
      tunnel?.close();
      await daemon.close();
    },
    (code) => process.exit(code),
  );
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  // A bug anywhere in the process ends it in order — runs marked unknown, lock
  // released — instead of a bare crash that leaves both behind.
  process.on("uncaughtException", (error) => {
    console.error(`portrail: fatal: ${error.stack ?? error}`);
    stop(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`portrail: fatal: ${(reason as Error)?.stack ?? reason}`);
    stop(1);
  });
  return new Promise(() => {});
}

// --------------------------------------------------------------- status

export async function status(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const dataDir = dataDirectory(flagString(args, "home"));
  const running = runningDaemon(dataDir);
  if (!running) {
    out(json, { running: false, dataDir }, () => `Portrail is not running (data: ${dataDir}).`);
    return 1;
  }
  try {
    const response = await fetch(`${running.url}/health`, { signal: AbortSignal.timeout(3000) });
    const health = (await response.json()) as Record<string, unknown>;
    const local = new LocalAnswers(running);
    const waiting = local.available ? await local.pending().then((r) => r.items).catch(() => []) : [];
    const { localToken: _secret, ...visible } = running;
    void _secret;
    out(json, { running: true, ...visible, ...health, waiting }, () => {
      const agents = (health.agents as Array<{ id: string; ready: boolean }>) ?? [];
      const pro = health.pro as { name: string; version: string; active?: boolean; detail?: string } | null;
      return (
        `Portrail ${health.version} running at ${running.url} (pid ${running.pid})\n` +
        `  agents: ${agents.map((agent) => `${agent.id}${agent.ready ? "" : " (not ready)"}`).join(", ") || "none"}\n` +
        `  pro:    ${pro ? `${pro.name} ${pro.version}${pro.detail ? ` (${pro.detail})` : ""}` : "not installed"}` +
        (waiting.length
          ? `\n  waiting for your answer:\n` + waiting.map((op) => `    ${op.id}  ${describeOperation(op.operation)}\n      portrail approve ${op.id}   |   portrail deny ${op.id}`).join("\n")
          : "")
      );
    });
    return 0;
  } catch (error) {
    const { localToken: _stale, ...visible } = running;
    void _stale;
    out(json, { running: false, stale: true, ...visible }, () => `A daemon record exists but ${running.url} did not answer: ${(error as Error).message}`);
    return 1;
  }
}

// ----------------------------------------------------------------- keys

export async function key(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const [action, name] = args.positional;
  const ctx = offline(flagString(args, "home"));
  try {
    switch (action) {
      case "create": {
        if (!name) throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail key create <name> [--scopes a,b] [--expires 90]");
        const scopes = flagString(args, "scopes")?.split(",").map((scope) => scope.trim());
        const expires = flagNumber(args, "expires");
        const { key, token } = ctx.keys.create({ name, scopes, expiresInDays: expires ?? null });
        out(json, { ...publicKey(key), token }, () =>
          `Created key "${key.name}" (${key.id})\n` +
          `  scopes:  ${key.scopes.join(", ")}\n` +
          `  expires: ${key.expiresAt ?? "never"}\n\n` +
          `  ${token}\n\n` +
          `This is the only time the token is shown. Store it somewhere safe.`,
        );
        return 0;
      }
      case "list": {
        const keys = ctx.keys.list().map(publicKey);
        out(json, { items: keys }, () =>
          keys.length
            ? keys
                .map((key) => `${key.revokedAt ? "revoked " : "active  "} ${key.id}  ${key.name.padEnd(20)} ${key.scopes.join(",")}  ${key.lastUsedAt ? `used ${key.lastUsedAt}` : "never used"}`)
                .join("\n")
            : "No keys yet. Create one with `portrail key create <name>`.",
        );
        return 0;
      }
      case "revoke": {
        if (!name) throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail key revoke <id>");
        const revoked = ctx.keys.revoke(name);
        out(json, publicKey(revoked), () => `Revoked ${revoked.name} (${revoked.id}).`);
        return 0;
      }
      default:
        throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail key create|list|revoke");
    }
  } finally {
    ctx.close();
  }
}

// ----------------------------------------------------------- workspaces

export async function workspace(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const [action, target] = args.positional;
  const ctx = offline(flagString(args, "home"));
  try {
    switch (action) {
      case "add": {
        if (!target) throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail workspace add <path> [--name project]");
        const root = resolve(target);
        const name = flagString(args, "name") ?? root.split("/").filter(Boolean).pop() ?? "workspace";
        const created = ctx.gateway.addWorkspace({ name, root });
        out(json, created, () => `Added workspace "${created.name}" → ${created.root}`);
        return 0;
      }
      case "list": {
        const items = ctx.gateway.listWorkspaces();
        out(json, { items }, () =>
          items.length
            ? items.map((workspace) => `${workspace.name.padEnd(20)} ${workspace.root}`).join("\n")
            : "No workspaces yet. Add one with `portrail workspace add <path>`.",
        );
        return 0;
      }
      case "remove": {
        if (!target) throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail workspace remove <name>");
        ctx.gateway.removeWorkspace(target);
        out(json, { removed: target }, () => `Removed workspace "${target}".`);
        return 0;
      }
      default:
        throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail workspace add|list|remove");
    }
  } finally {
    ctx.close();
  }
}

// ------------------------------------------------------------------ run

/** `portrail run "<prompt>"` — a client of the running daemon, through its own API. */
export async function run(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const prompt = args.positional.join(" ");
  if (!prompt) throw new PortrailError(400, "INVALID_REQUEST", 'Usage: portrail run "<prompt>" [--workspace name] [--agent codex|claude]');
  const dataDir = dataDirectory(flagString(args, "home"));
  const running = runningDaemon(dataDir);
  if (!running) throw new PortrailError(503, "DAEMON_NOT_RUNNING", "Portrail is not running. Start it with `portrail start`.");
  const token = flagString(args, "key") ?? process.env.PORTRAIL_KEY;
  if (!token) throw new PortrailError(401, "UNAUTHORIZED", "Pass --key prt_... or set PORTRAIL_KEY.");

  const { PortrailClient } = await import("../client/index.ts");
  const client = new PortrailClient({ baseUrl: running.url, token });
  const config = loadConfig(dataDir);
  const workspaces = await client.workspaces.list();
  const workspaceName = flagString(args, "workspace") ?? workspaces.items[0]?.name;
  if (!workspaceName) throw new PortrailError(400, "INVALID_REQUEST", "No workspace. Add one with `portrail workspace add <path>`.");

  const created = await client.runs.create({
    workspace: workspaceName,
    agent: (flagString(args, "agent") ?? config.defaultAgent) as "codex" | "claude",
    prompt,
  });
  if (json) {
    for await (const event of client.runs.events(created.id)) console.log(JSON.stringify(event));
    console.log(JSON.stringify(await client.runs.get(created.id), null, 2));
    return 0;
  }

  process.stderr.write(`run ${created.id} on ${workspaceName}\n`);
  const local = new LocalAnswers(running);
  for await (const event of client.runs.events(created.id)) {
    switch (event.type) {
      case "output.text":
        process.stdout.write(String(event.data.text ?? ""));
        break;
      case "command.started":
        process.stderr.write(`\n$ ${event.data.command}\n`);
        break;
      case "command.output":
        process.stderr.write(String(event.data.text ?? ""));
        break;
      case "operation.decided":
        if (event.data.verdict !== "allow")
          process.stderr.write(`\n[${event.data.verdict}] ${event.data.reason}\n`);
        break;
      case "approval.requested": {
        const operationId = String(event.data.operationId);
        process.stderr.write(`\n${describeOperation(event.data.operation)}\n  ${event.data.reason ?? ""}\n`);
        if (process.stdin.isTTY && local.available) {
          // Ask here, now, once. The stream keeps flowing underneath; the run waits.
          const verdict = await ask(`  Allow this once? [y/N] `);
          try {
            await local.answer(operationId, verdict);
            process.stderr.write(`  ${verdict === "allow" ? "allowed" : "refused"}\n`);
          } catch (error) {
            process.stderr.write(`  ${(error as Error).message}\n`);
          }
        } else {
          process.stderr.write(`  [waiting] answer from this machine with: portrail approve ${operationId}   (or portrail deny)\n`);
        }
        break;
      }
      case "run.completed":
        process.stdout.write("\n");
        process.stderr.write(`\n${event.data.state}\n`);
        break;
    }
  }
  const final = await client.runs.get(created.id);
  const denied = final.operations?.denied ?? 0;
  if (denied) process.stderr.write(`${denied} operation${denied === 1 ? " was" : "s were"} refused by your rules (exit 2).\n`);
  // 0: did everything asked. 2: finished, but something was refused. 1: did not finish.
  return final.state !== "succeeded" ? 1 : denied ? 2 : 0;
}


// ------------------------------------------------------------- answers

/** What a person sees before answering. Short, and exactly what the agent asked for. */
export function describeOperation(operation: unknown): string {
  const op = operation as any;
  if (!op || typeof op !== "object") return "an operation";
  switch (op.kind) {
    case "exec":
      return `$ ${op.command}${op.cwd ? `   (in ${op.cwd})` : ""}`;
    case "write":
      return `write ${op.changes.map((c: any) => `${c.change === "delete" ? "delete " : ""}${c.path}`).join(", ")}`;
    case "read":
      return `read ${op.paths.join(", ")}`;
    case "net":
      return `network access to ${op.host ?? op.url ?? "anywhere"}`;
    case "tool":
      return `tool ${op.server}/${op.tool}`;
    default:
      return String(op.kind);
  }
}

async function ask(question: string): Promise<"allow" | "deny"> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const reply = (await rl.question(question)).trim().toLowerCase();
    return reply === "y" || reply === "yes" ? "allow" : "deny";
  } finally {
    rl.close();
  }
}

/** The local answer channel: daemon.json's token, never an API key. */
class LocalAnswers {
  constructor(private readonly running: { url: string; localToken?: string }) {}

  get available() {
    return typeof this.running.localToken === "string" && this.running.localToken.length > 0;
  }

  private async call(method: string, path: string, body?: unknown) {
    if (!this.available) throw new PortrailError(403, "FORBIDDEN", "This Portrail was started by an older version; restart it to answer from the terminal.");
    const response = await fetch(`${this.running.url}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-portrail-local": this.running.localToken! },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => null)) as any;
    if (!response.ok) throw new PortrailError(response.status, payload?.error?.code ?? "ERROR", payload?.error?.message ?? `HTTP ${response.status}`);
    return payload;
  }

  pending(): Promise<{ items: OperationRecord[] }> {
    return this.call("GET", "/v1/operations/pending");
  }

  answer(operationId: string, verdict: "allow" | "deny"): Promise<OperationRecord> {
    return this.call("POST", `/v1/operations/${encodeURIComponent(operationId)}/answer`, { verdict, by: userInfo().username });
  }
}

/** `portrail approve [id]` / `portrail deny [id]` — answer a parked operation from this machine. */
export async function answer(args: ParsedArgs, verdict: "allow" | "deny"): Promise<number> {
  const json = flagBool(args, "json");
  const dataDir = dataDirectory(flagString(args, "home"));
  const running = runningDaemon(dataDir);
  if (!running) throw new PortrailError(503, "DAEMON_NOT_RUNNING", "Portrail is not running. Start it with `portrail start`.");
  const local = new LocalAnswers(running);
  const [given] = args.positional;
  let operationId = given;
  if (!operationId) {
    const { items } = await local.pending();
    if (items.length === 0) {
      out(json, { items: [] }, () => "Nothing is waiting for an answer.");
      return 1;
    }
    if (items.length > 1) {
      out(json, { items }, () => `${items.length} operations are waiting. Say which:\n` + items.map((op) => `  ${op.id}  ${describeOperation(op.operation)}`).join("\n"));
      return 1;
    }
    operationId = items[0]!.id;
  }
  const decided = await local.answer(operationId, verdict);
  out(json, decided, () => `${verdict === "allow" ? "Allowed" : "Refused"} once: ${describeOperation(decided.operation)}`);
  return 0;
}

export const approve = (args: ParsedArgs) => answer(args, "allow");
export const deny = (args: ParsedArgs) => answer(args, "deny");

// -------------------------------------------------------------- service

export async function service(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const [action] = args.positional;
  const dataDir = ensurePrivateDirectory(dataDirectory(flagString(args, "home")));
  switch (action) {
    case "install": {
      const extra: string[] = [];
      // Every flag `start` accepts is forwarded to the unit, including an extension's.
      for (const [flag, value] of args.flags) {
        if (flag === "home" || flag === "json") continue;
        extra.push(`--${flag}`, ...(value === true ? [] : [String(value)]));
      }
      const info = installService({ dataDir, extraArgs: extra });
      out(json, info, () => `Installed and started.\n  unit: ${info.unitPath}\n  check: ${info.hints.join("  |  ")}`);
      return 0;
    }
    case "uninstall": {
      const info = uninstallService();
      out(json, info, () => `Stopped and removed ${info.unitPath}.`);
      return 0;
    }
    case "status":
    case undefined: {
      const info = serviceInfo();
      out(json, info, () => (info.installed ? `Installed: ${info.unitPath}\n  check: ${info.hints.join("  |  ")}` : "Not installed as a service."));
      return 0;
    }
    default:
      throw new PortrailError(400, "INVALID_REQUEST", "Usage: portrail service install|uninstall|status");
  }
}

// ----------------------------------------------------------------- logs

/** Recent runs and their decisions, straight from the store. `-f` follows new events. */
export async function logs(args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const follow = flagBool(args, "f") || flagBool(args, "follow");
  const limit = flagNumber(args, "limit") ?? 20;
  const ctx = offline(flagString(args, "home"));
  try {
    const runs = ctx.store.list<RunRecord>("run").slice(-limit).reverse();
    if (json) {
      console.log(JSON.stringify({ items: runs }, null, 2));
    } else if (!runs.length) {
      console.log("No runs yet.");
    } else {
      for (const run of runs) {
        const ops = ctx.store
          .list<OperationRecord>("operation", run.sessionId)
          .filter((op) => op.runId === run.id);
        const denied = ops.filter((op) => op.decision?.verdict === "deny").length;
        console.log(
          `${run.createdAt}  ${run.state.padEnd(17)} ${run.id}  ${ops.length} ops${denied ? ` (${denied} denied)` : ""}\n` +
            `    ${run.prompt.replace(/\s+/g, " ").slice(0, 100)}${run.prompt.length > 100 ? "…" : ""}`,
        );
      }
    }
    if (!follow) return 0;
  } finally {
    ctx.close();
  }

  // Follow: poll the store for new events across all sessions.
  const seen = new Map<string, number>();
  const tail = offline(flagString(args, "home"));
  for (const session of tail.store.list<{ id: string; lastEventSeq: number }>("session"))
    seen.set(session.id, session.lastEventSeq);
  console.log("— following —");
  for (;;) {
    for (const session of tail.store.list<{ id: string; lastEventSeq: number }>("session")) {
      const after = seen.get(session.id) ?? 0;
      for (const event of tail.store.events(session.id, after, 200)) {
        seen.set(session.id, event.seq);
        if (json) console.log(JSON.stringify(event));
        else if (event.type === "output.text") process.stdout.write(String(event.data.text ?? ""));
        else if (event.type !== "output.reasoning" && event.type !== "usage")
          console.log(`\n[${event.timestamp}] ${event.type} ${event.runId ?? ""} ${summarise(event.data)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function summarise(data: Record<string, unknown>): string {
  if (typeof data.command === "string") return data.command;
  if (typeof data.state === "string") return String(data.state);
  if (typeof data.verdict === "string") return `${data.verdict}: ${data.reason ?? ""}`;
  if (data.operation && typeof data.operation === "object") {
    const op = data.operation as any;
    return `${op.kind} ${op.command ?? (op.changes ?? []).map((c: any) => c.path).join(",") ?? ""}`;
  }
  return "";
}
