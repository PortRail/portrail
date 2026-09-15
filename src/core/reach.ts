import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import { canonicalPath, isWithin } from "./paths.ts";

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** More files than this and a search is refused rather than judged file by file. */
export const REACH_LIMIT = 20_000;

/**
 * Stores under `.git` that hold compressed objects: a text search never matches
 * inside them, and they are large enough to make a judgement slow.
 */
const GIT_OBJECT_STORES = new Set(["objects", "lfs", "modules"]);

export interface Reach {
  /** Every regular file the search can read, as canonical paths. */
  files: string[];
  /** The walk hit the limit; `files` is incomplete. */
  truncated: boolean;
  /** A followed symlink that leaves the workspace, or null. */
  outside: string | null;
}

/**
 * What a search over `dir` can reach, the way the tool would walk it: hidden entries
 * only when the tool reads them, symlinks only when the tool follows them, never the
 * compressed object stores under `.git` and, unless asked, never `node_modules`. Bounded,
 * because a judgement that takes a second is a judgement nobody waits for.
 */
export function reachableFiles(
  dir: string,
  declaredRoot: string,
  options: {
    hidden: boolean;
    follow: boolean;
    limit?: number;
    /**
     * Leave `node_modules` out of the walk. On by default: every project ignores it,
     * walking it costs more than the limit allows, and what a package ships is not the
     * operator's secret. A caller that wants it judged passes `false`.
     */
    skipDependencies?: boolean;
  },
): Reach {
  const limit = options.limit ?? REACH_LIMIT;
  const skipDependencies = options.skipDependencies ?? true;
  const skipped = (parent: string, name: string) =>
    (skipDependencies && name === "node_modules") ||
    (GIT_OBJECT_STORES.has(name) && basename(parent) === ".git");
  const root = real(declaredRoot);
  const start = real(dir);
  const files: string[] = [];
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!options.hidden && entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && skipped(current, entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (!options.follow) continue;
        let target: string;
        try {
          target = canonicalPath(root, full);
        } catch {
          return { files, truncated: false, outside: full };
        }
        if (!isWithin(target, root)) return { files, truncated: false, outside: full };
        let info;
        try {
          info = statSync(target);
        } catch {
          continue; // dangling
        }
        if (info.isDirectory()) {
          if (!seen.has(target)) {
            seen.add(target);
            stack.push(target);
          }
          continue;
        }
        if (!seen.has(target)) {
          seen.add(target);
          files.push(target);
        }
      } else if (entry.isDirectory()) {
        stack.push(full);
      } else {
        files.push(full);
      }
      if (files.length >= limit) return { files, truncated: true, outside: null };
    }
  }
  return { files, truncated: false, outside: null };
}
