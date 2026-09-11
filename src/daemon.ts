import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type PortrailConfig } from "./config.ts";
import { Gateway } from "./core/gateway.ts";
import { Keys } from "./core/keys.ts";
import { BuiltinDecider } from "./decide/builtin.ts";
import { loadExtension } from "./extension-loader.ts";
import type { Extension, ExtensionHost } from "./extension.ts";
import { ClaudeProvider } from "./providers/claude/index.ts";
import { CodexProvider } from "./providers/codex/index.ts";
import { FakeProvider } from "./providers/fake/index.ts";
import type { Provider, ProviderStatus } from "./providers/types.ts";
import { createApp } from "./server/app.ts";
import { secret, Store } from "./store/index.ts";
import { dataDirectory, ensurePrivateDirectory } from "./store/paths.ts";
import type { AgentId } from "./types.ts";
import { version } from "./runtime.ts";

export interface DaemonOptions {
  home?: string;
  host?: string;
  port?: number;
  insecure?: boolean;
  /** Flags the core does not interpret; handed to the extension. */
  extensionOptions?: Record<string, string | boolean>;
  /** Include the scripted agent. Tests and demos only. */
  fake?: boolean;
  /** Skip the extension lookup. Tests use this to pin the built-in decider. */
  noExtension?: boolean;
}

export interface Daemon {
  dataDir: string;
  config: PortrailConfig;
  /** Answers a parked operation from this machine; written to daemon.json on start. */
  localToken: string;
  store: Store;
  gateway: Gateway;
  keys: Keys;
  extension: Extension | null;
  host: ExtensionHost;
  providers: Map<AgentId, Provider>;
  app: Awaited<ReturnType<typeof createApp>>;
  url: string;
  /** Latest probe of every agent; refreshed on demand. */
  agents(deep?: boolean): Promise<ProviderStatus[]>;
  close(): Promise<void>;
}

export const databasePath = (dataDir: string) => resolve(dataDir, "portrail.sqlite");

/** Build everything but do not listen yet. */
export async function assemble(options: DaemonOptions = {}): Promise<Omit<Daemon, "url">> {
  const dataDir = ensurePrivateDirectory(dataDirectory(options.home));
  const config = loadConfig(dataDir);
  const store = new Store(databasePath(dataDir));
  const keys = new Keys(store);

  const providers = new Map<AgentId, Provider>();
  providers.set("codex", new CodexProvider({ executablePath: config.agents.codex.path, dataDir }));
  providers.set("claude", new ClaudeProvider({ executablePath: config.agents.claude.path, maxBudgetUsd: config.run.maxBudgetUsd, sandbox: config.agents.claude.sandbox }));
  if (options.fake) providers.set("fake", new FakeProvider());

  const loaded = options.noExtension ? { extension: null, detail: "disabled" } : await loadExtension();
  const extension = loaded.extension;

  // Flags the core does not know belong to an extension. Without one, say so
  // plainly instead of starting as if they had been understood.
  const foreign = Object.keys(options.extensionOptions ?? {});
  if (foreign.length && !extension) {
    const list = foreign.map((flag) => `--${flag}`).join(", ");
    throw new Error(
      foreign.some((flag) => flag.startsWith("relay"))
        ? `${list}: relay mode is part of Portrail Pro, and Pro is not installed on this machine. The relay is only the public address; the machine that runs the agent needs Pro to connect to it.`
        : `Unknown option${foreign.length > 1 ? "s" : ""} ${list}. An installed extension may define it; none is loaded (${loaded.detail}).`,
    );
  }

  const gateway = new Gateway(store, providers, new BuiltinDecider(config.decide), {
    dataDir,
    maxConcurrent: config.run.maxConcurrent,
    defaultMaxSeconds: config.run.maxSeconds,
    approvalTimeoutMs: config.approvals.timeoutMinutes * 60 * 1000,
    maxQueued: 100,
  });
  // This process owns the runs, so it — and only it — reconciles what a previous
  // process left behind.
  gateway.recover();

  const host: ExtensionHost = {
    version,
    dataDir,
    store,
    gateway,
    options: options.extensionOptions ?? {},
    resolve: (operationId, decision, actor) => gateway.resolve(operationId, decision, actor),
  };
  const decider = extension?.decider?.(host) ?? null;
  if (decider) gateway.useDecider(decider);
  if (extension?.onEvent) gateway.on("event", extension.onEvent);

  // Shallow probes only, so nothing periodic (health checks, the CLI) ever costs inference.
  let cachedAgents: { at: number; value: ProviderStatus[] } | null = null;
  const agents = async (deep = false) => {
    if (deep) return Promise.all([...providers.values()].map((provider) => provider.probe({ deep: true })));
    if (cachedAgents && Date.now() - cachedAgents.at < 60_000) return cachedAgents.value;
    const value = await Promise.all([...providers.values()].map((provider) => provider.probe()));
    cachedAgents = { at: Date.now(), value };
    return value;
  };

  const tls = config.tls.cert && config.tls.key ? { cert: config.tls.cert, key: config.tls.key } : null;
  const localToken = secret();
  const app = await createApp({
    gateway,
    store,
    keys,
    dataDir,
    extension,
    host,
    tls,
    insecure: options.insecure,
    localToken,
    agentStatus: agents,
  });

  const retention = setInterval(() => gateway.retention(config.retentionDays), 60 * 60 * 1000);
  retention.unref();

  return {
    dataDir,
    config,
    localToken,
    store,
    gateway,
    keys,
    extension,
    host,
    providers,
    app,
    agents,
    close: async () => {
      clearInterval(retention);
      await gateway.shutdown();
      await extension?.close?.();
      await app.close();
      store.close();
    },
  };
}

/** Assemble and listen. This is `portrail start`. */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const daemon = await assemble(options);
  const { config, dataDir } = daemon;
  const host = options.host ?? config.listen.host;
  const port = options.port ?? config.listen.port;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const tls = Boolean(config.tls.cert);
  if (!loopback && !tls && !options.insecure)
    throw new Error(
      `Refusing to listen on ${host} without TLS. Configure tls.cert/tls.key, put Portrail behind a TLS proxy or tunnel, or pass --insecure if you understand that API keys would travel in the clear.`,
    );

  if (!loopback && !tls)
    console.error(
      `WARNING: listening on ${host} without TLS because --insecure was given. API keys will travel in the clear. Use this only on a network you fully control.`,
    );

  const lock = resolve(dataDir, "daemon.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error(`Another Portrail is already running from ${dataDir} (pid ${pid}).`);
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { mode: 0o600, flag: "wx" });

  try {
    await daemon.app.listen({ host, port });
  } catch (error) {
    unlinkSync(lock);
    await daemon.close();
    throw error;
  }
  const url = `${tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  writeFileSync(resolve(dataDir, "daemon.json"), JSON.stringify({ url, pid: process.pid, startedAt: new Date().toISOString(), localToken: daemon.localToken }), { mode: 0o600 });
  await daemon.extension?.start?.(daemon.host, { url });

  return {
    ...daemon,
    url,
    close: async () => {
      await daemon.close();
      for (const file of [lock, resolve(dataDir, "daemon.json")])
        if (existsSync(file) && (file !== lock || readFileSync(file, "utf8") === String(process.pid)))
          unlinkSync(file);
    },
  };
}

/** Where a running daemon says it is, if one is running. */
export function runningDaemon(dataDir: string): { url: string; pid: number; localToken?: string } | null {
  const path = resolve(dataDir, "daemon.json");
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as { url: string; pid: number; localToken?: string };
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}
