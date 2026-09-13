import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateDirectories,
  findExecutable,
  probeExecutable,
} from "../src/providers/detect.ts";

test("candidate directories are unique and include PATH", () => {
  const directories = candidateDirectories();
  assert.equal(new Set(directories).size, directories.length, "no duplicates");
  const first = (process.env.PATH ?? "").split(":").find(Boolean);
  if (first) assert.ok(directories.includes(first));
});

test("an agent hidden by a Node version switch is still found", () => {
  // The real failure this guards: `npm i -g codex` under Node 22, then run under
  // Node 24. The binary still exists, it is simply no longer on PATH.
  const home = mkdtempSync(join(tmpdir(), "portrail-home-"));
  const bin = join(home, ".nvm", "versions", "node", "v22.0.0", "bin");
  mkdirSync(bin, { recursive: true });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    // PATH may already carry an nvm bin; what matters is that the version directories under HOME are added.
    assert.ok(
      candidateDirectories().includes(bin),
      "every nvm version's bin directory under HOME is searched",
    );
  } finally {
    process.env.HOME = previous;
  }
});

test("a configured path is used verbatim and a missing one is reported clearly", () => {
  const directory = mkdtempSync(join(tmpdir(), "portrail-detect-"));
  const binary = join(directory, "pretend-agent");
  writeFileSync(binary, "#!/bin/sh\necho 'pretend 1.2.3'\n");
  chmodSync(binary, 0o755);

  const found = findExecutable("pretend-agent", binary);
  assert.equal(found?.path, binary);

  assert.throws(
    () => findExecutable("pretend-agent", join(directory, "nope")),
    /does not exist/,
  );
});

test("probing runs the binary directly, with no shell in between", async () => {
  const directory = mkdtempSync(join(tmpdir(), "portrail-detect-"));
  // A name containing a space would break any shell-concatenated invocation.
  const binary = join(directory, "agent with space");
  writeFileSync(binary, "#!/bin/sh\necho 'pretend-cli 1.2.3'\n");
  chmodSync(binary, 0o755);

  const probed = await probeExecutable("agent with space", {
    configured: binary,
    parse: (output) => output.trim().replace(/^pretend-cli\s+/, ""),
  });
  assert.equal(probed.found, true);
  assert.equal(probed.version, "1.2.3");
});

test("a missing binary reports not-found rather than throwing", async () => {
  const probed = await probeExecutable("portrail-definitely-not-installed");
  assert.equal(probed.found, false);
  assert.equal(probed.version, null);
  assert.match(probed.error ?? "", /not found/);
});
