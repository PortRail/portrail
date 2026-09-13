import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Executable {
  found: boolean;
  path: string | null;
  version: string | null;
  /** True when we found it somewhere PATH does not cover. */
  offPath: boolean;
  error?: string;
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Places a globally installed agent CLI realistically ends up.
 *
 * Agents are usually installed with `npm i -g`, which puts them in the bin directory
 * of whichever Node version was active at the time. Switching Node versions then
 * hides them from PATH — a confusing failure we would rather diagnose than inherit.
 */
export function candidateDirectories(): string[] {
  const home = homedir();
  const directories: string[] = [];

  for (const entry of (process.env.PATH ?? "").split(delimiter))
    if (entry) directories.push(entry);

  const nvmVersions = join(home, ".nvm", "versions", "node");
  for (const version of safeReaddir(nvmVersions))
    directories.push(join(nvmVersions, version, "bin"));

  for (const extra of [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ])
    directories.push(extra);

  return [...new Set(directories)];
}

function onPath(directory: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).includes(directory);
}

/** Find a binary, preferring PATH, then the places agents actually get installed. */
export function findExecutable(
  command: string,
  configured?: string | null,
): { path: string; offPath: boolean } | null {
  if (configured) {
    if (!existsSync(configured))
      throw new Error(`Configured path for ${command} does not exist: ${configured}`);
    return { path: configured, offPath: !onPath(join(configured, "..")) };
  }
  for (const directory of candidateDirectories()) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return { path: candidate, offPath: !onPath(directory) };
  }
  return null;
}

/**
 * Locate a binary and ask it for its version. Never goes through a shell — the
 * arguments are passed as an array so nothing is concatenated or re-parsed.
 */
export async function probeExecutable(
  command: string,
  options: {
    configured?: string | null;
    versionArgs?: string[];
    parse?: (output: string) => string;
  } = {},
): Promise<Executable> {
  const { versionArgs = ["--version"], parse = (output) => output.trim() } = options;

  let located: { path: string; offPath: boolean } | null;
  try {
    located = findExecutable(command, options.configured);
  } catch (error) {
    return {
      found: false,
      path: null,
      version: null,
      offPath: false,
      error: (error as Error).message,
    };
  }

  if (!located)
    return {
      found: false,
      path: null,
      version: null,
      offPath: false,
      error: `${command} was not found on PATH or in the usual install locations.`,
    };

  try {
    const { stdout } = await run(located.path, versionArgs, {
      timeout: 15000,
      maxBuffer: 1 << 16,
    });
    return {
      found: true,
      path: located.path,
      version: parse(stdout),
      offPath: located.offPath,
    };
  } catch (error) {
    return {
      found: true,
      path: located.path,
      version: null,
      offPath: located.offPath,
      error: `${located.path} did not report a version: ${(error as Error).message}`,
    };
  }
}

export const probeCodex = (configured?: string | null) =>
  probeExecutable("codex", {
    configured,
    parse: (output) => output.trim().replace(/^codex-cli\s+/, ""),
  });

export const probeClaudeCli = (configured?: string | null) =>
  probeExecutable("claude", {
    configured,
    parse: (output) => output.trim().replace(/\s*\(Claude Code\)$/, ""),
  });

/** Is the optional Claude Agent SDK importable from this installation? */
export async function claudeSdkAvailable(): Promise<{
  available: boolean;
  version: string | null;
  error?: string;
}> {
  try {
    await import("@anthropic-ai/claude-agent-sdk");
    // The package's exports map hides package.json, so resolve the module's own
    // entry file and read the manifest beside it.
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    let version: string | null = null;
    try {
      const entry = createRequire(import.meta.url).resolve(
        "@anthropic-ai/claude-agent-sdk",
      );
      const manifest = JSON.parse(
        readFileSync(join(dirname(entry), "package.json"), "utf8"),
      ) as {
        version?: string;
        claudeCodeVersion?: string;
      };
      version = manifest.claudeCodeVersion
        ? `${manifest.version} (Claude Code ${manifest.claudeCodeVersion})`
        : (manifest.version ?? null);
    } catch {
      // Still usable without a version string.
    }
    return { available: true, version };
  } catch (error) {
    return { available: false, version: null, error: (error as Error).message };
  }
}

/**
 * Does this machine hold a Claude Code login, without asking Claude anything?
 * The SDK reads the OS keychain on macOS and ~/.claude/.credentials.json elsewhere;
 * an API key in the environment also counts. This is a presence check, not proof
 * the credential is valid — doctor --live does the real thing.
 */
export async function detectClaudeCredentials(): Promise<{
  present: boolean;
  source: "api_key" | "keychain" | "credentials_file" | null;
}> {
  if (process.env.ANTHROPIC_API_KEY) return { present: true, source: "api_key" };
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  if (existsSync(join(configDir, ".credentials.json")))
    return { present: true, source: "credentials_file" };
  if (process.platform === "darwin") {
    try {
      await run(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials"],
        { timeout: 5000 },
      );
      return { present: true, source: "keychain" };
    } catch {
      // not in the keychain
    }
  }
  return { present: false, source: null };
}
