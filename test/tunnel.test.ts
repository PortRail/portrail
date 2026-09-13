import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  isTunnelKind,
  openTunnel,
  TUNNEL_KINDS,
  type TunnelKind,
} from "../src/tunnel.ts";

test("an unknown tunnel kind is a rejected promise that names the choices, not a thrown TypeError", async () => {
  await assert.rejects(
    () => openTunnel("bogus" as TunnelKind, 1234),
    /Unknown tunnel "bogus".*cloudflare/,
  );
  assert.deepEqual([...TUNNEL_KINDS], ["cloudflare", "ngrok", "tailscale"]);
  assert.ok(isTunnelKind("ngrok"));
  assert.ok(!isTunnelKind("bogus"));
  assert.ok(!isTunnelKind(true));
});

/** Put a `cloudflared` stand-in first on PATH for the duration of `body`. */
async function withFakeCloudflared<T>(body: string, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "portrail-tunnel-"));
  const script = join(dir, "cloudflared");
  writeFileSync(script, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(script, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}

test("a tunnel URL that arrives split across two output chunks is still recognised", async () => {
  await withFakeCloudflared(
    `process.stderr.write("INF https://abc-");
     setTimeout(() => { process.stderr.write("def.trycloudflare.com\\n"); setInterval(() => {}, 1000); }, 50);`,
    async () => {
      const tunnel = await openTunnel("cloudflare", 1234, { timeoutMs: 2000 });
      try {
        assert.equal(tunnel.url, "https://abc-def.trycloudflare.com");
      } finally {
        tunnel.close();
      }
    },
  );
});

test("a URL printed without a trailing newline before the process exits is still recognised", async () => {
  await withFakeCloudflared(
    `process.stdout.write("ready at https://xyz.trycloudflare.com");`,
    async () => {
      const tunnel = await openTunnel("cloudflare", 1234, { timeoutMs: 2000 });
      assert.equal(tunnel.url, "https://xyz.trycloudflare.com");
      tunnel.close();
    },
  );
});

test("a multi-byte character split across chunks reaches the log intact", async () => {
  const seen: string[] = [];
  await withFakeCloudflared(
    `const bytes = Buffer.from("caf\\u00e9 ready\\n");
     process.stderr.write(bytes.subarray(0, 4));
     setTimeout(() => {
       process.stderr.write(bytes.subarray(4));
       process.stderr.write("https://split.trycloudflare.com\\n");
       setInterval(() => {}, 1000);
     }, 50);`,
    async () => {
      const tunnel = await openTunnel("cloudflare", 1234, {
        timeoutMs: 2000,
        onLog: (line) => seen.push(line),
      });
      tunnel.close();
    },
  );
  assert.ok(seen.includes("café ready"), JSON.stringify(seen));
});
