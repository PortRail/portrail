import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Commands Codex's "untrusted" policy runs without asking. Read-only and harmless
 * in Codex's own model — but Portrail promises the operator that *every* command is
 * checked against their rules, and "harmless" includes `cat ~/.ssh/id_rsa`.
 *
 * Listing a command that was never auto-trusted costs nothing: it prompted anyway.
 */
const AUTO_TRUSTED_COMMANDS = [
  "cat",
  "cd",
  "echo",
  "false",
  "find",
  "grep",
  "head",
  "ls",
  "nl",
  "pwd",
  "rg",
  "sed",
  "tail",
  "true",
  "wc",
  "which",
  "whoami",
  "git",
  "base64",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "stat",
  "file",
  "env",
  "printenv",
  "date",
  "uname",
  "id",
  "hostname",
  "df",
  "du",
  "ps",
  "tree",
  "jq",
  "xxd",
  "od",
  "strings",
];

const MANAGED_MARKER = "# Managed by Portrail.";

/** Minimal config: nothing personal leaks in, and every knob Portrail cares about is set per thread. */
const CONFIG_TOML = `${MANAGED_MARKER} Edit ~/.codex/config.toml for your own Codex sessions, not this file.
sandbox_mode = "workspace-write"
approval_policy = "untrusted"
`;

function rulesFile(): string {
  return [
    `${MANAGED_MARKER} Portrail asks the operator's rules about every command, including the`,
    "# read-only ones Codex would otherwise run silently.",
    ...AUTO_TRUSTED_COMMANDS.map(
      (command) => `prefix_rule(pattern=[${JSON.stringify(command)}], decision="prompt")`,
    ),
    "",
  ].join("\n");
}

export interface CodexHome {
  /** Pass as CODEX_HOME. Thread history lives here, so it must persist across runs. */
  path: string;
  /** Where the login came from, or null when only an API key can authenticate. */
  authSource: string | null;
}

/**
 * Give Codex a home of its own under the Portrail data directory.
 *
 * Why not the user's `~/.codex`? Because it is *theirs*: it carries their model pin
 * (which may not exist for this CLI), `sandbox_mode = "danger-full-access"`, plugins,
 * MCP servers, and a `notify` hook that launches an app after every turn. Portrail
 * would have to fight each of those individually, and lose to the next one added.
 *
 * The login is shared through a symlink to the real `auth.json`, so token refreshes
 * write through to the file the user's own Codex reads. Nothing else is shared.
 */
export function prepareCodexHome(dataDir: string): CodexHome {
  const path = resolve(dataDir, "codex");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(join(path, "rules"), { recursive: true, mode: 0o700 });

  writeManaged(join(path, "config.toml"), CONFIG_TOML);
  writeManaged(join(path, "rules", "portrail.rules"), rulesFile());

  const sourceHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : resolve(homedir(), ".codex");
  const sourceAuth = join(sourceHome, "auth.json");
  const link = join(path, "auth.json");

  let authSource: string | null = null;
  if (existsSync(sourceAuth)) {
    const current = existsSync(link) || isDangling(link) ? safeReadlink(link) : null;
    if (current !== sourceAuth) {
      if (current !== null || isDangling(link)) unlinkSync(link);
      symlinkSync(sourceAuth, link);
    }
    authSource = sourceAuth;
  } else if (isDangling(link)) {
    unlinkSync(link);
  }

  return { path, authSource };
}

/** Only overwrite files we wrote ourselves; never clobber something a person edited. */
function writeManaged(target: string, content: string) {
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing === content) return;
    if (!existing.startsWith(MANAGED_MARKER))
      throw new Error(
        `${target} was edited by hand. Remove it to let Portrail manage it, or keep your edits and expect them to be honoured.`,
      );
  }
  writeFileSync(target, content, { mode: 0o600 });
}

function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function isDangling(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

/** The environment a Portrail-driven Codex process runs with. Nothing else leaks through. */
export function codexEnvironment(home: CodexHome): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    CODEX_HOME: home.path,
    ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.CODEX_API_KEY ? { CODEX_API_KEY: process.env.CODEX_API_KEY } : {}),
  };
}
