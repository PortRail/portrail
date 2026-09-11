import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up to the installed package root so Portrail works from source or from dist. */
function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (directory !== parse(directory).root) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      ) as { name?: string };
      if (manifest.name === "portrail") return directory;
    } catch {
      // Not our manifest, or unreadable. Keep walking.
    }
    directory = dirname(directory);
  }
  throw new Error("Portrail installation root not found.");
}

export const installRoot = packageRoot();

export const version: string = (
  JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

export const resourcePath = (...parts: string[]) => join(installRoot, ...parts);

export const DEFAULT_PORT = 7431;
export const API_PREFIX = "/v1";
