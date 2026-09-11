import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configPath, DEFAULT_CONFIG, loadConfig, saveConfig } from "../config.ts";
import { dataDirectory, ensurePrivateDirectory } from "../store/paths.ts";
import { Store } from "../store/index.ts";
import { Keys } from "../core/keys.ts";
import { adminGateway } from "./commands.ts";
import { databasePath } from "../daemon.ts";

export interface InitOptions {
  home?: string | undefined;
  json: boolean;
  /** A folder to enrol as the first workspace. "." is the usual answer. */
  workspace?: string | undefined;
  workspaceName?: string | undefined;
  /** Name for the first API key. */
  key?: string | undefined;
}

/**
 * Set up everything a first run needs: data directory, config, and — when asked —
 * a workspace and a key, so `portrail init --workspace . && portrail start` works.
 */
export async function init(options: InitOptions) {
  const dir = ensurePrivateDirectory(dataDirectory(options.home));
  const created: string[] = [];

  if (!existsSync(configPath(dir))) {
    saveConfig(dir, DEFAULT_CONFIG);
    created.push(configPath(dir));
  }
  const fresh = !existsSync(databasePath(dir));
  const store = new Store(databasePath(dir));
  if (fresh) created.push(databasePath(dir));
  const config = loadConfig(dir);

  let workspace: { name: string; root: string } | null = null;
  let key: { name: string; id: string; token: string } | null = null;
  try {
    const gateway = adminGateway(store, config, dir);
    if (options.workspace) {
      const root = resolve(options.workspace);
      const name = options.workspaceName ?? root.split("/").filter(Boolean).pop() ?? "workspace";
      const existing = gateway.listWorkspaces().find((w) => w.root === root || w.name === name);
      workspace = existing ?? gateway.addWorkspace({ name, root });
    }
    if (options.key) {
      const keys = new Keys(store);
      const made = keys.create({ name: options.key });
      key = { name: made.key.name, id: made.key.id, token: made.token };
    }
    const workspaces = gateway.listWorkspaces();
    const keys = new Keys(store).list().filter((k) => !k.revokedAt);

    if (options.json) {
      console.log(JSON.stringify({ dataDir: dir, created, workspace, key: key ? { ...key, token: key.token } : null, workspaces: workspaces.length, keys: keys.length }, null, 2));
      return 0;
    }

    console.log(`Portrail is set up in ${dir}`);
    for (const path of created) console.log(`  created   ${path}`);
    if (workspace) console.log(`  workspace ${workspace.name} → ${workspace.root}`);
    if (key) console.log(`  key       ${key.name} (${key.id})\n\n    ${key.token}\n\n  This is the only time the token is shown.\n  export PORTRAIL_KEY=${key.token}`);

    const todo: string[] = [];
    if (!workspaces.length) todo.push("portrail workspace add /path/to/project --name project   (or: portrail init --workspace .)");
    if (!keys.length) todo.push("portrail key create local                                (or: portrail init --key local)");
    todo.push("portrail start");
    console.log(`\nNext:\n${todo.map((line, i) => `  ${i + 1}. ${line}`).join("\n")}`);
    return 0;
  } finally {
    store.close();
  }
}
