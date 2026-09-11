#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `Portrail needs Node.js 24 or newer (it uses the SQLite built into Node). You are running v${process.versions.node}.\n` +
      "Install Node 24: https://nodejs.org/ or `nvm install 24 && nvm use 24`.",
  );
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "cli", "main.js");

if (!existsSync(entry)) {
  console.error(
    "Portrail is not built. Run `npm run build` in the source tree, or reinstall the package.",
  );
  process.exit(1);
}

await import(entry);
