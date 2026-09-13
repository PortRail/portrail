import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension } from "../src/extension-loader.ts";

/** Point PORTRAIL_EXTENSION at a module with this source (or at a missing file when null), run, restore. */
async function withExtension(source: string | null, fn: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "portrail-loader-"));
  const file = join(dir, "ext.mjs");
  if (source !== null) writeFileSync(file, source);
  const previous = process.env.PORTRAIL_EXTENSION;
  process.env.PORTRAIL_EXTENSION = file;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.PORTRAIL_EXTENSION;
    else process.env.PORTRAIL_EXTENSION = previous;
  }
}

test("a configured extension that throws on import stops the load", () =>
  withExtension(`throw new Error("bad build");`, () =>
    assert.rejects(loadExtension(), /failed to load.*bad build/),
  ));

test("a configured module that is not an extension is refused", () =>
  withExtension(`export default { version: "1" };`, () =>
    assert.rejects(loadExtension(), /did not export a Portrail extension/),
  ));

test("a configured path that does not exist is refused rather than ignored", () =>
  withExtension(null, () => assert.rejects(loadExtension(), /was not found/)));

test("with nothing configured and no extension installed, the loader reports not installed", async () => {
  const previous = process.env.PORTRAIL_EXTENSION;
  delete process.env.PORTRAIL_EXTENSION;
  try {
    assert.deepEqual(await loadExtension(), {
      extension: null,
      detail: "not installed",
    });
  } finally {
    if (previous !== undefined) process.env.PORTRAIL_EXTENSION = previous;
  }
});

test("the daemon does not assemble with a broken configured extension", () =>
  withExtension(`throw new Error("bad build");`, async () => {
    const { assemble } = await import("../src/daemon.ts");
    await assert.rejects(
      assemble({ home: mkdtempSync(join(tmpdir(), "portrail-home-")) }),
      /bad build/,
    );
  }));
