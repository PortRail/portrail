import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Canonicalise a path the agent declared. Existing components are resolved with
 * realpath; a symlink at the leaf — even a dangling one — is followed; whatever does
 * not exist yet is appended to the deepest real ancestor. The result is what the
 * filesystem would actually touch.
 */
export function canonicalPath(root: string, declared: string): string {
  let full = resolve(root, declared);
  for (let hops = 0; hops < 16; hops++) {
    let info;
    try {
      info = lstatSync(full);
    } catch {
      // Does not exist: canonicalise the parent, keep the leaf.
      return join(canonicalPath(root, dirname(full)), basename(full));
    }
    if (!info.isSymbolicLink()) return realpathSync.native(full);
    const target = readlinkSync(full);
    full = isAbsolute(target) ? target : resolve(dirname(full), target);
  }
  throw new Error("Too many symlink hops.");
}

export function isWithin(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The protected list is compared without regard to case on every platform. Existing
 * paths already carry their on-disk spelling; this catches a leaf that does not exist
 * yet, and a false hit here only ever refuses.
 */
export function isWithinFold(candidate: string, parent: string): boolean {
  return isWithin(candidate.toLowerCase(), parent.toLowerCase());
}
