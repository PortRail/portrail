import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { loadConfig, configPath } from "../config.ts";
import { dataDirectory } from "../store/paths.ts";
import { version } from "../runtime.ts";
import { loadExtension } from "../extension-loader.ts";
import { detectTunnels } from "../tunnel.ts";
import { CodexProvider } from "../providers/codex/index.ts";
import { ClaudeProvider } from "../providers/claude/index.ts";
import { probeClaudeCli, probeCodex } from "../providers/detect.ts";
import { databasePath, runningDaemon } from "../daemon.ts";
import { Store } from "../store/index.ts";
import { Keys } from "../core/keys.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * The support tool. Every check answers the question a stuck user actually has:
 * "will a run work, and if not, what do I type next?" `--live` makes the agent
 * checks talk to the agents for real (Claude's costs one tiny call).
 */
export async function collectChecks(
  home: string | undefined,
  live = false,
): Promise<Check[]> {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);

  checks.push({
    name: "Node.js",
    ok: nodeMajor >= 24,
    detail: `v${process.versions.node} on ${process.platform}/${process.arch}`,
    ...(nodeMajor >= 24
      ? {}
      : { fix: "Portrail needs Node 24 or newer: nvm install 24" }),
  });

  const dir = dataDirectory(home);
  const exists = existsSync(dir);
  const mode = exists ? statSync(dir).mode & 0o777 : null;
  checks.push({
    name: "Data directory",
    ok: !exists || mode === 0o700,
    detail: exists
      ? `${dir} (mode ${mode?.toString(8)})`
      : `${dir} (not created yet — run portrail init)`,
    ...(exists && mode !== 0o700 ? { fix: `chmod 700 ${dir}` } : {}),
  });

  let config;
  try {
    config = loadConfig(dir);
    checks.push({
      name: "Config",
      ok: true,
      detail: existsSync(configPath(dir))
        ? `${configPath(dir)} is valid`
        : "built-in defaults (portrail init writes a file)",
    });
  } catch (error) {
    checks.push({
      name: "Config",
      ok: false,
      detail: (error as Error).message,
      fix: `Fix or delete ${configPath(dir)}`,
    });
  }

  // ---- agents: the same probes the daemon uses, so doctor and reality agree
  const codexBinary = await probeCodex(config?.agents.codex.path);
  const codex = await new CodexProvider({
    executablePath: config?.agents.codex.path ?? null,
    dataDir: dir,
  }).probe({ deep: live });
  checks.push({
    name: "Codex",
    ok: codex.ready,
    detail: codex.installed
      ? `${codex.detail}${codexBinary.offPath ? ` Found at ${codexBinary.path} (not on PATH).` : ""}`
      : "not installed",
    ...(codex.ready
      ? codexBinary.offPath
        ? {
            fix: `Pin it: set agents.codex.path to "${codexBinary.path}" in ${configPath(dir)}`,
          }
        : {}
      : codex.installed
        ? { fix: "Sign in: codex login" }
        : { fix: "Install the Codex CLI, then: codex login" }),
  });

  const claudeCli = await probeClaudeCli(config?.agents.claude.path);
  const claude = await new ClaudeProvider({
    executablePath: config?.agents.claude.path ?? null,
  }).probe({ deep: live });
  checks.push({
    name: "Claude Code",
    ok: claude.ready,
    detail: claude.installed
      ? `${claude.detail}${claudeCli.found ? ` CLI ${claudeCli.version} at ${claudeCli.path}.` : ""}`
      : `adapter missing${claudeCli.found ? ` (CLI ${claudeCli.version} is installed)` : ""}`,
    ...(claude.ready
      ? {}
      : claude.installed
        ? { fix: "Sign in once: run `claude` and log in. Or set ANTHROPIC_API_KEY." }
        : {
            fix: "npm install -g @anthropic-ai/claude-agent-sdk (or reinstall Portrail without --omit=optional)",
          }),
  });

  if (!codex.ready && !claude.ready)
    checks.push({
      name: "Any agent",
      ok: false,
      detail: "neither agent is ready, so no run can start",
      fix: "Fix at least one of the two agent checks above.",
    });

  // ---- workspaces and keys: a daemon with neither cannot do anything
  if (config && existsSync(databasePath(dir))) {
    const store = new Store(databasePath(dir));
    try {
      const workspaces = store.list<{ name: string }>("workspace");
      checks.push({
        name: "Workspaces",
        ok: workspaces.length > 0,
        detail: workspaces.length
          ? workspaces.map((w) => w.name).join(", ")
          : "none enrolled",
        ...(workspaces.length
          ? {}
          : { fix: "portrail workspace add /path/to/project --name project" }),
      });
      const keys = new Keys(store)
        .list()
        .filter(
          (key) =>
            !key.revokedAt &&
            (!key.expiresAt || Date.parse(key.expiresAt) > Date.now()),
        );
      checks.push({
        name: "API keys",
        ok: keys.length > 0,
        detail: keys.length ? `${keys.length} active` : "none",
        ...(keys.length ? {} : { fix: "portrail key create local" }),
      });
    } finally {
      store.close();
    }
  } else {
    checks.push({
      name: "Workspaces",
      ok: false,
      detail: "not set up yet",
      fix: "portrail init --workspace /path/to/project",
    });
  }

  // ---- listener: "in use" is fine if it is us
  if (config) {
    const running = runningDaemon(dir);
    const free = await portFree(config.listen.host, config.listen.port);
    checks.push({
      name: "Gateway",
      ok: free || !!running,
      detail: running
        ? `running at ${running.url} (pid ${running.pid})`
        : free
          ? `not running; ${config.listen.host}:${config.listen.port} is free`
          : `${config.listen.host}:${config.listen.port} is in use by something else`,
      ...(free || running
        ? {}
        : { fix: "Stop whatever holds the port, or set listen.port in config.json." }),
    });
  }

  const tunnels = detectTunnels().filter((tunnel) => tunnel.installed);
  checks.push({
    name: "Tunnel",
    ok: true,
    detail: tunnels.length
      ? `${tunnels.map((t) => t.binary).join(", ")} installed — portrail start --tunnel ${tunnels[0]!.kind}`
      : "none installed — only needed to reach a laptop from the internet (cloudflared, ngrok, tailscale)",
  });

  try {
    const pro = await loadExtension();
    const status = pro.extension?.status?.(dir) ?? {
      active: !!pro.extension,
      detail: "",
    };
    checks.push({
      name: "Portrail Pro",
      ok: true,
      detail: pro.extension
        ? `${pro.detail}${status.detail ? ` — ${status.detail}` : ""}${status.active ? " — rule engine, approvals, audit, webhooks" : " — running with the built-in allow/deny list"}`
        : `${pro.detail} — built-in allow/deny list`,
    });
  } catch (error) {
    // A present extension that cannot load stops `portrail start`; say so here first.
    checks.push({ name: "Portrail Pro", ok: false, detail: (error as Error).message });
  }

  return checks;
}

export async function doctor(home: string | undefined, json: boolean, live = false) {
  const checks = await collectChecks(home, live);
  const failed = checks.filter((check) => !check.ok);
  if (json) {
    console.log(
      JSON.stringify({ version, live, ok: failed.length === 0, checks }, null, 2),
    );
    return failed.length ? 1 : 0;
  }
  console.log(`Portrail ${version}${live ? " (live checks)" : ""}\n`);
  for (const check of checks) {
    console.log(
      `${check.ok ? "  ok " : "  ✗  "} ${check.name.padEnd(15)} ${check.detail}`,
    );
    if (check.fix) console.log(`      ${" ".repeat(15)} → ${check.fix}`);
  }
  console.log(
    failed.length
      ? `\n${failed.length} thing${failed.length === 1 ? "" : "s"} to fix before a run will work.`
      : "\nReady. A run will work.",
  );
  if (!live)
    console.log(
      "Agent sign-in was checked from credentials on disk; add --live to verify with the agents.",
    );
  return failed.length ? 1 : 0;
}
