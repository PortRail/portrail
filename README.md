# Portrail

**An HTTP API in front of the coding agent on your own machine.**

Install Portrail next to Codex or Claude Code, give it a folder and an API key, and drive
the agent from anything that can make an HTTP request — `curl`, a script, Zapier, Make,
n8n, your own app. The agent does real work: it runs commands and edits files. Your rules
decide what it may do without asking.

```sh
npm install -g portrail
portrail init
portrail workspace add ~/code/my-app --name my-app
portrail key create local
portrail start
```

```sh
curl -X POST http://127.0.0.1:7431/v1/runs \
  -H "Authorization: Bearer prt_…" \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","workspace":"my-app","prompt":"Fix the failing test in auth.ts","wait":300}'
```

That request returns when the agent is done, with what it did and what it said.

## What you get

- **Both agents.** Codex and Claude Code, through their own permission hooks, using the
  login you already have. No API keys for the agents, no copied credentials.
- **Every action goes through one decision point.** Each command and file change the
  agent proposes is checked against your rules before it starts. A refused operation is
  never started, and the agent is told why. What an _allowed_ operation then does is the
  agent's — and its sandbox's — business, not Portrail's.
- **A real API.** Runs, sessions, resumable event streams, cancel, steer, `wait` for
  synchronous callers, idempotency keys for automations that retry.
- **Reachable from anywhere.** Bind to an interface with TLS, put it behind a proxy, or
  `portrail start --tunnel` for a public URL on a laptop behind NAT.
- **Honest about failure.** If Portrail loses track of an agent mid-run, the run ends as
  `outcome_unknown` — never a silent success, never a replay. A run that finished but had
  something refused says so: `operations.denied` is on every run, and `portrail run` exits 2.
- **Runs as a service.** `portrail service install` on macOS or Linux.

## How it works

Both agents ask permission before acting. Codex sends a request over its app-server
protocol; Claude Code calls a hook. Portrail answers those questions from your rules,
which means it governs what the agent _does_ without being a sandbox around it.

```
                ┌──────────────┐    "may I run npm test?"    ┌───────────┐
 curl / Make ──▶│   Portrail    │◀───────────────────────────│  Codex or │
 SDK / CLI  ◀──│  HTTP API    │───────────────────────────▶│  Claude   │
                └──────┬───────┘    allow / deny             └─────┬─────┘
                       │                                           │
                  your rules                                 your files
```

The free version ships with an **allow/deny list**: reads and workspace writes are free,
a named set of development commands is free, secret files are refused for reading and
writing, obviously destructive and network commands are refused, and anything unmatched
is refused — or, if you put it in `decide.ask`, `portrail run` asks you "Allow this once?
[y/N]" at the terminal. Compound commands are judged one segment at a time. It is a starting point
for a repository you trust, not a security boundary against hostile input — read
[security.md](docs/security.md) before pointing an agent at untrusted content.

**Portrail Pro** adds a rule engine with globs and regexes, approvals from anywhere (a
signed link in Slack or email, the API from another machine, with `run` / `session` /
`always` scopes), an audit log, webhooks, relay mode for machines behind NAT, and fleet
management. It installs as a plugin on the machine that
runs the agent (`portrail start --relay` needs it there, not only on the relay); the free
product is complete without it.

## Requirements

- **Node.js 24** or newer. Portrail uses the SQLite that ships with Node, so `npm install`
  never compiles anything.
- **Codex CLI** signed in (`codex login`), and/or **Claude Code** signed in (`claude`).
- macOS or Linux.

`portrail doctor` checks all of it and tells you what to fix.

## Documentation

- [Quickstart](docs/quickstart.md) — from install to first run in five minutes
- [Rules](docs/rules.md) — the allow/deny list, and how commands are matched
- [API reference](docs/api.md) — every route, with curl examples
- [Remote access](docs/remote.md) — TLS, reverse proxies, tunnels, and a Make.com recipe
- [Security model](docs/security.md) — what Portrail protects against and what it does not
- [SDK](docs/sdk.md) — the TypeScript client

## Status

0.1.0 — early release. Tested on macOS and Ubuntu 24.04 with both agents: real runs,
tarball install, the systemd service, crash recovery under `kill -9`, and a Cloudflare
tunnel from the public internet. The API is stable within 0.x for the routes documented
in [docs/api.md](docs/api.md); see [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT. See `LICENSE`.
