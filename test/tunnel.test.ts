import { test } from "node:test";
import assert from "node:assert/strict";
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
