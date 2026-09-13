import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";

/** Where Portrail keeps its database, config and logs. */
export function dataDirectory(override?: string): string {
  const chosen =
    override ?? process.env.PORTRAIL_HOME ?? resolve(homedir(), ".portrail");
  if (!isAbsolute(chosen)) throw new Error("PORTRAIL_HOME must be an absolute path.");
  return chosen;
}

function statOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Create the data directory as a real, private, 0700 leaf whose ancestors cannot be
 * replaced by another account. API keys live here, so a world-writable parent would
 * let another local user swap the directory out from under us.
 */
export function ensurePrivateDirectory(directory: string): string {
  const existing = statOrUndefined(directory);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error(`Portrail data must be a real directory, not a link: ${directory}`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(directory);
  const own = lstatSync(canonical);
  const uid = process.getuid?.();

  if (uid !== undefined && own.uid !== uid)
    throw new Error(`Portrail data directory belongs to another account: ${canonical}`);
  if ((own.mode & 0o077) !== 0)
    throw new Error(
      `Portrail data directory must not be readable by others (chmod 700 ${canonical}).`,
    );

  let parent = dirname(canonical);
  for (;;) {
    const info = lstatSync(parent);
    const foreign = uid !== undefined && info.uid !== 0 && info.uid !== uid;
    const sticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (foreign || ((info.mode & 0o022) !== 0 && !sticky))
      throw new Error(`Portrail data directory has an unsafe parent: ${parent}`);
    if (parent === dirname(parent)) break;
    parent = dirname(parent);
  }
  return canonical;
}
