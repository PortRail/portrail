import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PORT } from "./runtime.ts";
import { PortrailError } from "./contracts/errors.ts";

export interface PortrailConfig {
  version: 1;
  listen: { host: string; port: number };
  tls: { cert: string | null; key: string | null };
  defaultAgent: "codex" | "claude";
  /** Explicit binary paths, for agents installed outside the current PATH. */
  agents: { codex: { path: string | null }; claude: { path: string | null; sandbox: "required" | "best-effort" } };
  run: { maxSeconds: number; maxConcurrent: number; maxBudgetUsd: number | null };
  /** How long a parked operation may wait for an answer before it is refused. */
  approvals: { timeoutMinutes: number };
  /**
   * The built-in decider. Pro replaces this with policy.json.
   * deny wins; allow passes; ask parks the run until someone at this machine answers
   * (portrail run prompts, or portrail approve/deny); anything else is refused.
   */
  decide: { allow: string[]; deny: string[]; ask: string[] };
  retentionDays: number;
}

/**
 * Balanced defaults: reading and editing inside the workspace are free, the common
 * development commands are free, secrets and destructive commands are refused, and
 * anything unmatched is denied. Put a pattern in `ask` to be asked at the terminal
 * instead; Pro turns that into approvals from anywhere, by anyone, with a record.
 */
export const DEFAULT_CONFIG: PortrailConfig = {
  version: 1,
  listen: { host: "127.0.0.1", port: DEFAULT_PORT },
  tls: { cert: null, key: null },
  defaultAgent: "codex",
  agents: { codex: { path: null }, claude: { path: null, sandbox: "required" } },
  run: { maxSeconds: 900, maxConcurrent: 2, maxBudgetUsd: null },
  approvals: { timeoutMinutes: 15 },
  decide: {
    allow: [
      "read:**",
      "write:**",
      // Package scripts by name, never "run anything in package.json".
      "exec:npm test*",
      "exec:npm run test*",
      "exec:npm run build*",
      "exec:npm run lint*",
      "exec:npm run typecheck*",
      "exec:npm run check*",
      "exec:pnpm test*",
      "exec:pnpm run test*",
      "exec:pnpm run build*",
      "exec:pnpm run lint*",
      "exec:yarn test*",
      "exec:yarn build*",
      "exec:yarn lint*",
      "exec:node --test*",
      "exec:node --version",
      "exec:tsc*",
      "exec:git status*",
      "exec:git diff*",
      "exec:git log*",
      "exec:git show*",
      "exec:git branch*",
      "exec:git ls-files*",
      "exec:git rev-parse*",
      "exec:git blame*",
      "exec:git add *",
      "exec:git commit *",
      // Read-only tools, including the ones Codex composes into compounds.
      "exec:ls*",
      "exec:cat *",
      "exec:head *",
      "exec:tail *",
      "exec:sed -n *",
      "exec:rg *",
      "exec:grep *",
      "exec:find *",
      "exec:wc *",
      "exec:sort*",
      "exec:uniq*",
      "exec:cut *",
      "exec:tr *",
      "exec:diff *",
      "exec:stat *",
      "exec:file *",
      "exec:which *",
      "exec:command -v *",
      "exec:type *",
      "exec:pwd",
      "exec:echo *",
      "exec:printf *",
      "exec:true",
      "exec:false",
      "exec:test *",
      "exec:date*",
      "exec:uname*",
      "exec:basename *",
      "exec:dirname *",
      "exec:realpath *",
    ],
    deny: [
      // Secrets: neither written nor read, by path or by command.
      "write:.env*",
      "write:**/.env*",
      "write:.git/**",
      "write:**/*.pem",
      "write:**/id_rsa*",
      "write:**/id_ed25519*",
      "read:.env*",
      "read:**/.env*",
      "read:**/*.pem",
      "read:**/id_rsa*",
      "read:**/id_ed25519*",
      "exec:*.ssh/*",
      "exec:*.aws/*",
      "exec:*.gnupg/*",
      "exec:*.netrc*",
      "exec:*.npmrc*",
      "exec:*/.env*",
      "exec:*.env",
      "exec:*.env.*",
      "exec:*.pem*",
      "exec:*id_rsa*",
      "exec:*id_ed25519*",
      "exec:*credentials*",
      "exec:*.docker/config.json*",
      "exec:*.kube/*",
      // Read-only tools with a write or execute mode of their own.
      "exec:find *-exec*",
      "exec:find *-ok*",
      "exec:find *-delete*",
      "exec:find *-fprint*",
      "exec:find *-fls*",
      "exec:sed *w *",
      "exec:sed *W *",
      // The agents' own configuration and credentials, and this gateway's data directory.
      "exec:*/.codex/*",
      "exec:*/.claude/*",
      "exec:*/.config/claude*",
      "exec:*/.portrail/*",
      "exec:*.gitconfig*",
      "exec:*.pypirc*",
      // Destructive or outward-facing commands.
      "exec:sudo *",
      "exec:su *",
      "exec:doas *",
      "exec:rm -rf /*",
      "exec:rm -rf ~*",
      "exec:rm -rf $HOME*",
      "exec:npm publish*",
      "exec:pnpm publish*",
      "exec:yarn publish*",
      "exec:cargo publish*",
      "exec:gem push*",
      "exec:twine upload*",
      "exec:git push*",
      "exec:shutdown*",
      "exec:reboot*",
      "exec:mkfs*",
      "exec:dd *",
      "exec:curl *",
      "exec:wget *",
      "exec:ssh *",
      "exec:scp *",
      "exec:nc *",
      "exec:python* -c *",
      "exec:node -e *",
      "exec:node --eval*",
      "exec:eval *",
      "exec:sh -c *",
      "exec:bash -c *",
      "exec:zsh -c *",
      "net:*",
    ],
    // Empty on purpose: a run driven from Make.com has nobody at the terminal, and an
    // unanswered ask is a 15-minute stall. Put "exec:*" here to be asked about every
    // command the lists do not cover.
    ask: [],
  },
  retentionDays: 30,
};

export const configPath = (dataDir: string) => resolve(dataDir, "config.json");

function invalid(message: string): never {
  throw new PortrailError(400, "INVALID_CONFIG", message);
}

export function validateConfig(input: unknown): PortrailConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("config.json must contain a JSON object.");
  const raw = input as Record<string, any>;
  const merged: PortrailConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    listen: { ...DEFAULT_CONFIG.listen, ...(raw.listen ?? {}) },
    tls: { ...DEFAULT_CONFIG.tls, ...(raw.tls ?? {}) },
    run: { ...DEFAULT_CONFIG.run, ...(raw.run ?? {}) },
    approvals: { ...DEFAULT_CONFIG.approvals, ...(raw.approvals ?? {}) },
    agents: {
      codex: { ...DEFAULT_CONFIG.agents.codex, ...(raw.agents?.codex ?? {}) },
      claude: { ...DEFAULT_CONFIG.agents.claude, ...(raw.agents?.claude ?? {}) },
    },
    decide: { ...DEFAULT_CONFIG.decide, ...(raw.decide ?? {}) },
    version: 1,
  };

  const { host, port } = merged.listen;
  if (typeof host !== "string" || !host) invalid("listen.host must be a hostname or IP.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    invalid("listen.port must be a port from 1 to 65535.");
  if (!["codex", "claude"].includes(merged.defaultAgent))
    invalid('defaultAgent must be "codex" or "claude".');
  if (!Number.isInteger(merged.run.maxSeconds) || merged.run.maxSeconds < 30)
    invalid("run.maxSeconds must be an integer of at least 30.");
  if (!Number.isInteger(merged.run.maxConcurrent) || merged.run.maxConcurrent < 1)
    invalid("run.maxConcurrent must be at least 1.");
  if (merged.run.maxBudgetUsd !== null && !(typeof merged.run.maxBudgetUsd === "number" && merged.run.maxBudgetUsd > 0))
    invalid("run.maxBudgetUsd must be a positive number or null.");
  if (!Number.isInteger(merged.approvals.timeoutMinutes) || merged.approvals.timeoutMinutes < 1 || merged.approvals.timeoutMinutes > 1440)
    invalid("approvals.timeoutMinutes must be 1–1440.");
  for (const field of ["allow", "deny", "ask"] as const)
    if (
      !Array.isArray(merged.decide[field]) ||
      merged.decide[field].some((entry) => typeof entry !== "string")
    )
      invalid(`decide.${field} must be an array of "kind:pattern" strings.`);
  for (const agent of ["codex", "claude"] as const) {
    const path = merged.agents[agent].path;
    if (path !== null && (typeof path !== "string" || !path.startsWith("/")))
      invalid(`agents.${agent}.path must be an absolute path or null.`);
  }
  if (merged.agents.claude.sandbox !== "required" && merged.agents.claude.sandbox !== "best-effort")
    invalid('agents.claude.sandbox must be "required" or "best-effort".');
  if ((merged.tls.cert === null) !== (merged.tls.key === null))
    invalid("tls.cert and tls.key must both be set, or both be null.");
  if (!Number.isInteger(merged.retentionDays) || merged.retentionDays < 1)
    invalid("retentionDays must be at least 1.");

  return merged;
}

export function loadConfig(dataDir: string): PortrailConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PortrailError(
      400,
      "INVALID_CONFIG",
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
  return validateConfig(parsed);
}

export function saveConfig(dataDir: string, config: PortrailConfig) {
  writeFileSync(configPath(dataDir), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}
