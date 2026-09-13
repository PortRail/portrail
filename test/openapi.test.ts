import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { Keys } from "../src/core/keys.ts";
import { testGateway } from "./helpers.ts";

test("every registered route is documented in openapi.json, and vice versa", async () => {
  const spec = JSON.parse(
    readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
  );
  const documented = new Set<string>();
  for (const [path, methods] of Object.entries<any>(spec.paths))
    for (const method of Object.keys(methods))
      documented.add(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`);

  const { gateway, store } = testGateway();
  const app = await createApp({
    gateway,
    store,
    keys: new Keys(store),
    dataDir: mkdtempSync(join(tmpdir(), "portrail-oas-")),
    extension: null,
    agentStatus: async () => [],
  });
  await app.ready();
  // printRoutes draws a tree; rebuild full paths from the indentation.
  const registered = new Set<string>();
  const stack: Array<{ depth: number; path: string }> = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = line.match(/^([│├└─\s]*)(\S+)\s+\(([A-Z, ]+)\)/);
    if (!match) continue;
    const depth = match[1]!.length;
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    const path = (stack.at(-1)?.path ?? "") + match[2];
    stack.push({ depth, path });
    for (const method of match[3]!.split(/,\s*/))
      if (method !== "HEAD") registered.add(`${method} ${path}`);
  }
  await app.close();
  await gateway.shutdown();

  const missing = [...registered].filter((route) => !documented.has(route));
  const stale = [...documented].filter((route) => !registered.has(route));
  assert.deepEqual(missing, [], "routes with no documentation");
  assert.deepEqual(stale, [], "documented routes that do not exist");
});
