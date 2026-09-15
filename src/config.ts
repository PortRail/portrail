import { REACH_LIMIT } from "./core/reach.ts";
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
  agents: {
    codex: { path: string | null };
    claude: { path: string | null; sandbox: "required" | "best-effort" };
  };
  run: { maxSeconds: number; maxConcurrent: number; maxBudgetUsd: number | null };
  /** How long a parked operation may wait for an answer before it is refused. */
  approvals: { timeoutMinutes: number };
  /**
   * The built-in decider. Pro replaces this with policy.json.
   * deny wins; allow passes; ask parks the run until someone at this machine answers
   * (portrail run prompts, or portrail approve/deny); anything else is refused.
   */
  decide: {
    allow: string[];
    deny: string[];
    ask: string[];
    /**
     * How many files a single search may reach before it is refused instead of judged
     * file by file. Raise it for a large repository, at the cost of a slower judgement.
     * Optional in the type so lists written by hand stay valid; a loaded config always
     * carries it, 20 000 unless set.
     */
    reachLimit?: number;
  };
  retentionDays: number;
}

/**
 * Balanced defaults: reading and editing inside the workspace are free, the common
 * development commands are free, secrets and destructive commands are refused, and
 * anything unmatched is denied. Put a pattern in `ask` to be asked at the terminal
 * instead; Pro turns that into approvals from anywhere, by anyone, with a record.
 */
/** How long a run may take, in seconds: the same bounds for config.json and the API. */
export const RUN_MAX_SECONDS = { min: 30, max: 4 * 3600 } as const;

/** A command with and without arguments: `npm test` and `npm test -- x`, never `npm testx`. */
const plain = (command: string) => [`exec:${command}`, `exec:${command} *`];
/** A package script by name, with arguments, and its `name:variant` forms (`test:unit`). */
const script = (runner: string, name: string) => [
  ...plain(`${runner} ${name}`),
  `exec:${runner} ${name}:*`,
];

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
      ...script("npm", "test"),
      ...script("npm run", "test"),
      ...script("npm run", "build"),
      ...script("npm run", "lint"),
      ...script("npm run", "typecheck"),
      ...script("npm run", "check"),
      ...script("pnpm", "test"),
      ...script("pnpm run", "test"),
      ...script("pnpm run", "build"),
      ...script("pnpm run", "lint"),
      ...script("pnpm run", "typecheck"),
      ...script("yarn", "test"),
      ...script("yarn", "build"),
      ...script("yarn", "lint"),
      // `node --test` alone runs the project's tests like `npm test` does; with a file it
      // runs that file, which is `node <file>` and deliberately not here.
      "exec:node --test",
      "exec:node --version",
      ...plain("tsc"),
      ...plain("git status"),
      ...plain("git diff"),
      ...plain("git log"),
      ...plain("git show"),
      ...plain("git ls-files"),
      ...plain("git rev-parse"),
      ...plain("git blame"),
      // Listing branches, never deleting, moving or forcing them.
      "exec:git branch",
      "exec:git branch --show-current",
      "exec:git branch -a",
      "exec:git branch -r",
      "exec:git branch -v",
      "exec:git branch -vv",
      "exec:git branch -av",
      "exec:git branch -avv",
      "exec:git branch --list",
      "exec:git branch --list *",
      "exec:git branch --merged*",
      "exec:git branch --no-merged*",
      "exec:git branch --contains *",
      "exec:git add *",
      "exec:git commit *",
      // Read-only tools, including the ones Codex composes into compounds.
      ...plain("ls"),
      "exec:cat *",
      "exec:head *",
      "exec:tail *",
      // sed is a language: the decider lets through only scripts that print or filter.
      "exec:sed *",
      "exec:rg *",
      "exec:grep *",
      "exec:find *",
      "exec:wc *",
      ...plain("sort"),
      ...plain("uniq"),
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
      ...plain("date"),
      ...plain("uname"),
      "exec:basename *",
      "exec:dirname *",
      "exec:realpath *",
    ],
    deny: [
      // Secrets: neither written nor read, by path or by command.
      "write:.env*",
      "write:**/.env*",
      "write:**/.envrc",
      "write:.git/**",
      "write:**/*.pem",
      "write:**/id_rsa*",
      "write:**/id_ed25519*",
      "read:.env*",
      "read:**/.env*",
      "read:**/.envrc",
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
      "exec:*.envrc*",
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
      "exec:git *--output*",
      "exec:sort *-o *",
      "exec:sort *-o/*",
      "exec:sort *--output*",
      "exec:sort *--compress-program*",
      "exec:rg *--pre*",
      "exec:tree *-o *",
      // Branch surgery: -D deletes (and, since matching ignores case, so does -d), -M and -f move or force.
      "exec:git branch *-D *",
      "exec:git branch *-fD *",
      "exec:git branch *-Df *",
      "exec:git branch *--delete*",
      "exec:git branch *-M *",
      "exec:git branch *--move*",
      "exec:git branch *-f *",
      "exec:git branch *--force*",
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
      // Inline code and loaders: `node -e`, `node -p`, `--import`, `--require` run whatever follows.
      "exec:python* -c *",
      "exec:node -e *",
      "exec:node -*e *",
      "exec:node --eval*",
      "exec:node -*p *",
      "exec:node --print*",
      "exec:node -r *",
      "exec:node *--require*",
      "exec:node *--import*",
      "exec:node *--loader*",
      "exec:node *--experimental-loader*",
      "exec:node *--input-type*",
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
    reachLimit: REACH_LIMIT,
  },
  retentionDays: 30,
};

/** What `decide.reachLimit` may be set to: enough to be useful, bounded so a judgement stays quick. */
export const REACH_LIMIT_BOUNDS = { min: 100, max: 1_000_000 } as const;

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
  if (typeof host !== "string" || !host)
    invalid("listen.host must be a hostname or IP.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    invalid("listen.port must be a port from 1 to 65535.");
  if (!["codex", "claude"].includes(merged.defaultAgent))
    invalid('defaultAgent must be "codex" or "claude".');
  if (
    !Number.isInteger(merged.run.maxSeconds) ||
    merged.run.maxSeconds < RUN_MAX_SECONDS.min ||
    merged.run.maxSeconds > RUN_MAX_SECONDS.max
  )
    invalid(
      `run.maxSeconds must be an integer from ${RUN_MAX_SECONDS.min} to ${RUN_MAX_SECONDS.max}.`,
    );
  if (!Number.isInteger(merged.run.maxConcurrent) || merged.run.maxConcurrent < 1)
    invalid("run.maxConcurrent must be at least 1.");
  if (
    merged.run.maxBudgetUsd !== null &&
    !(typeof merged.run.maxBudgetUsd === "number" && merged.run.maxBudgetUsd > 0)
  )
    invalid("run.maxBudgetUsd must be a positive number or null.");
  if (
    !Number.isInteger(merged.approvals.timeoutMinutes) ||
    merged.approvals.timeoutMinutes < 1 ||
    merged.approvals.timeoutMinutes > 1440
  )
    invalid("approvals.timeoutMinutes must be 1–1440.");
  for (const field of ["allow", "deny", "ask"] as const)
    if (
      !Array.isArray(merged.decide[field]) ||
      merged.decide[field].some((entry) => typeof entry !== "string")
    )
      invalid(`decide.${field} must be an array of "kind:pattern" strings.`);
  const reachLimit = merged.decide.reachLimit as unknown;
  if (
    reachLimit !== undefined &&
    (typeof reachLimit !== "number" ||
      !Number.isInteger(reachLimit) ||
      reachLimit < REACH_LIMIT_BOUNDS.min ||
      reachLimit > REACH_LIMIT_BOUNDS.max)
  )
    invalid(
      `decide.reachLimit must be an integer from ${REACH_LIMIT_BOUNDS.min} to ${REACH_LIMIT_BOUNDS.max}.`,
    );
  for (const agent of ["codex", "claude"] as const) {
    const path = merged.agents[agent].path;
    if (path !== null && (typeof path !== "string" || !path.startsWith("/")))
      invalid(`agents.${agent}.path must be an absolute path or null.`);
  }
  if (
    merged.agents.claude.sandbox !== "required" &&
    merged.agents.claude.sandbox !== "best-effort"
  )
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
