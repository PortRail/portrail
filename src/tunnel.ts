import { spawn, type ChildProcess } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { StringDecoder } from "node:string_decoder";
import { findExecutable } from "./providers/detect.ts";

export type TunnelKind = "cloudflare" | "ngrok" | "tailscale";

export interface TunnelStatus {
  kind: TunnelKind;
  binary: string;
  installed: boolean;
  path: string | null;
  note: string;
}

const TUNNELS: Array<{ kind: TunnelKind; binary: string; note: string }> = [
  {
    kind: "cloudflare",
    binary: "cloudflared",
    note: "Free. Random URL per start; a named tunnel gives a permanent one.",
  },
  {
    kind: "ngrok",
    binary: "ngrok",
    note: "Free tier gives a random URL; paid plans give a fixed one.",
  },
  {
    kind: "tailscale",
    binary: "tailscale",
    note: "Funnel exposes the port on your tailnet's public hostname.",
  },
];

/** Which tunnel tools this machine has. `doctor` reports these. */
export function detectTunnels(): TunnelStatus[] {
  return TUNNELS.map(({ kind, binary, note }) => {
    const found = findExecutable(binary);
    return { kind, binary, installed: !!found, path: found?.path ?? null, note };
  });
}

export interface Tunnel {
  kind: TunnelKind;
  url: string;
  close(): void;
}

/**
 * Open an outbound tunnel to a local port and resolve with its public URL.
 *
 * This is the answer for a laptop behind NAT: no port forwarding, no static IP,
 * works from any network. The tunnel process is a child of the daemon and dies
 * with it.
 */
export const TUNNEL_KINDS: readonly TunnelKind[] = TUNNELS.map((entry) => entry.kind);
export const isTunnelKind = (value: unknown): value is TunnelKind =>
  typeof value === "string" && (TUNNEL_KINDS as readonly string[]).includes(value);

export function openTunnel(
  kind: TunnelKind,
  port: number,
  options: { timeoutMs?: number; onLog?: (line: string) => void } = {},
): Promise<Tunnel> {
  const spec = TUNNELS.find((entry) => entry.kind === kind);
  if (!spec)
    return Promise.reject(
      new Error(`Unknown tunnel "${kind}". Choose ${TUNNEL_KINDS.join(", ")}.`),
    );
  const found = findExecutable(spec.binary);
  if (!found)
    return Promise.reject(
      new Error(
        `${spec.binary} is not installed. Install it, or choose another tunnel.`,
      ),
    );

  const args =
    kind === "cloudflare"
      ? ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"]
      : kind === "ngrok"
        ? ["http", String(port), "--log", "stdout", "--log-format", "logfmt"]
        : ["funnel", String(port)];

  const child: ChildProcess = spawn(found.path, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pattern =
    kind === "cloudflare"
      ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
      : kind === "ngrok"
        ? /url=(https:\/\/[^\s]+)/
        : /(https:\/\/[a-z0-9.-]+\.ts\.net[^\s]*)/;

  return new Promise<Tunnel>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `${spec.binary} did not report a public URL within ${(options.timeoutMs ?? 30_000) / 1000}s.`,
        ),
      );
    }, options.timeoutMs ?? 30_000);
    const consider = (line: string) => {
      if (!line.trim()) return;
      options.onLog?.(line);
      const match = line.match(pattern);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        const url = (match[1] ?? match[0]).replace(/\/$/, "");
        resolve({ kind, url, close: () => child.kill() });
      }
    };
    // The tool writes when it likes: a URL may straddle two chunks, and so may one
    // character. Decode and cut into lines per stream; the tail waits for its newline.
    const lines = (stream: NodeJS.ReadableStream | null | undefined) => {
      const decoder = new StringDecoder("utf8");
      let rest = "";
      stream?.on("data", (chunk: Buffer) => {
        const parts = (rest + decoder.write(chunk)).split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts) consider(line);
      });
      return () => {
        consider(rest + decoder.end());
        rest = "";
      };
    };
    const flushOut = lines(child.stdout);
    const flushErr = lines(child.stderr);
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    // "close" fires after both pipes have drained, "exit" may not — flush there.
    child.on("close", (code) => {
      flushOut();
      flushErr();
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(
          new Error(`${spec.binary} exited with code ${code} before reporting a URL.`),
        );
      }
    });
  });
}

/**
 * A fresh quick-tunnel hostname takes ten to sixty seconds to appear in DNS, and a
 * local resolver that saw NXDOMAIN once may cache that for longer. Ask a public
 * resolver directly so "ready" means a caller anywhere can actually connect.
 */
export async function waitForDns(
  url: string,
  options: { timeoutMs?: number; onTick?: (elapsedMs: number) => void } = {},
): Promise<boolean> {
  const host = new URL(url).hostname;
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    try {
      const addresses = await resolver.resolve4(host);
      if (addresses.length) return true;
    } catch {
      // Not there yet.
    }
    options.onTick?.(Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}
