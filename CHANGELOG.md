# Changelog

All notable changes to Portrail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.1.0] — 2026-09-11

First public release.

- An HTTP API in front of Codex and Claude Code on the machine it is installed on:
  runs, sessions, workspaces, keys, server-sent events with replay, `wait` mode.
- Every operation the agent proposes — read, write, exec, net, tool — is decided by
  the gateway before it happens; workspace containment runs before any rule.
- Built-in allow / deny / ask lists; commands judged one segment at a time, with
  substitutions, redirects, globs, variable expansions and environment assignments
  refused rather than guessed at.
- `portrail run` asks "Allow this once? [y/N]" at the terminal for operations in the
  ask list; `portrail approve` / `portrail deny` answer from another terminal.
- Codex runs in a managed `CODEX_HOME` with an "untrusted" approval policy; Claude Code
  runs with an OS sandbox required by default.
- Crash recovery with an honest `outcome_unknown` state; nothing is retried on its own.
- Tunnels (`cloudflared`, `ngrok`, `tailscale`), launchd and systemd user services,
  a TypeScript SDK, an OpenAPI description, and an extension seam for Portrail Pro.
