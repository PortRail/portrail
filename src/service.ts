import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resourcePath } from "./runtime.ts";

const LABEL = "io.portrail.gateway";

export interface ServiceInfo {
  platform: "darwin" | "linux";
  unitPath: string;
  installed: boolean;
  /** How to check on it, in the platform's own words. */
  hints: string[];
}

function unitPath(platform: NodeJS.Platform): string {
  const home = homedir();
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const base = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(base, "systemd", "user", "portrail.service");
}

export function serviceInfo(platform: NodeJS.Platform = process.platform, dataDir: string = defaultDataDir()): ServiceInfo {
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(`Running Portrail as a service is supported on macOS and Linux, not ${platform}.`);
  const path = unitPath(platform);
  return {
    platform,
    unitPath: path,
    installed: existsSync(path),
    hints:
      platform === "darwin"
        ? [`launchctl print gui/$(id -u)/${LABEL}`, `tail -f ${logPath(dataDir)}`]
        : ["systemctl --user status portrail", "journalctl --user -u portrail -f"],
  };
}

const defaultDataDir = () => process.env.PORTRAIL_HOME ?? join(homedir(), ".portrail");
/** The service logs next to its data, whichever directory that is. */
const logPath = (dataDir: string) => join(dataDir, "portrail.log");

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One systemd token: double-quoted, with backslash, quote and the specifier character escaped. */
export const systemdQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export interface UnitInput {
  node: string;
  cli: string;
  args: string[];
  dataDir: string;
  path: string;
}

export function renderSystemdUnit(input: UnitInput): string {
  return `[Unit]
Description=Portrail agent gateway
After=network-online.target

[Service]
ExecStart=${[input.node, input.cli, ...input.args].map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PORTRAIL_HOME=${input.dataDir}`)}
Environment=${systemdQuote(`PATH=${input.path}`)}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlist(input: UnitInput & { home: string }): string {
  const log = logPath(input.dataDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(input.node)}</string>
    <string>${escapeXml(input.cli)}</string>
${input.args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PORTRAIL_HOME</key><string>${escapeXml(input.dataDir)}</string>
    <key>PATH</key><string>${escapeXml(input.path)}</string>
    <key>HOME</key><string>${escapeXml(input.home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict></plist>
`;
}

/**
 * Write the unit and start it. The unit runs the same `portrail start` a person
 * would, with the same data directory, so nothing behaves differently as a service.
 */
export function installService(options: { dataDir: string; extraArgs?: string[] }): ServiceInfo {
  const info = serviceInfo(process.platform, options.dataDir);
  const input: UnitInput = {
    node: process.execPath,
    cli: resourcePath("bin", "portrail.mjs"),
    args: ["start", ...(options.extraArgs ?? [])],
    dataDir: options.dataDir,
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  mkdirSync(join(info.unitPath, ".."), { recursive: true });

  if (info.platform === "darwin") {
    writeFileSync(info.unitPath, renderLaunchdPlist({ ...input, home: homedir() }), { mode: 0o600 });
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFileSync("launchctl", ["bootout", domain, info.unitPath], { stdio: "ignore" });
    } catch {
      // Not loaded yet.
    }
    execFileSync("launchctl", ["bootstrap", domain, info.unitPath], { stdio: "inherit" });
  } else {
    writeFileSync(info.unitPath, renderSystemdUnit(input), { mode: 0o600 });
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "portrail"], { stdio: "inherit" });
  }
  return serviceInfo(process.platform, options.dataDir);
}

export function uninstallService(dataDir: string = defaultDataDir()): ServiceInfo {
  const info = serviceInfo(process.platform, dataDir);
  if (!info.installed) return info;
  if (info.platform === "darwin") {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, info.unitPath], { stdio: "ignore" });
    } catch {
      // Already stopped.
    }
  } else {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "portrail"], { stdio: "ignore" });
    } catch {
      // Already stopped.
    }
  }
  unlinkSync(info.unitPath);
  return serviceInfo(process.platform, dataDir);
}

