# Changelog

All notable changes to Portrail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

### Security

- A search that says what it opens is judged by that alone: `rg -g '*.ts'`, `rg -t ts`,
  `grep -r --include='*.ts'` and Claude Code's Grep with `glob` or `type` are no longer
  refused because of a `.env` they would never open. Portrail reads the filters the way
  the tool does (last matching glob wins, slashless globs match at any depth, slashed
  globs anchor to the working directory) and falls back to judging the whole directory
  when it cannot be sure.
- The listener bounds what a caller can hold open: a request must arrive within 30 s, a
  connection idle for 60 s is closed, a key may hold twenty `wait=` responses at once
  (`TOO_MANY_WAITS`) and a caller that disconnects frees its slot. Ten failed
  authentications from one address within a minute lock that address out for the rest of
  it (`TOO_MANY_FAILURES`, `Retry-After`); every failure is logged with the address, the
  code and the route. Forwarded addresses are believed only from a loopback peer.

## [0.1.1] — 2026-09-13

Every change below was first reproduced by a failing test in the suite.

### Security

- Every path a command names is resolved to its spelling on disk and must lie inside the
  workspace, the same rule reads and writes already follow. `cat /etc/passwd`,
  `ls ~/Documents` and `grep -r x ~` are refused; on a case-insensitive filesystem `.ENV`
  is `.env` and `~/.SSH` is `~/.ssh`.
- A command that names a file is judged as a read of that file by its real path, so a
  symlink alias inside the workspace no longer hides a secret from the deny rules.
- Searches over a directory (`grep -r`, `rg`, `diff -r`, Claude Code's Grep) are judged
  by every file they can reach and refused when they reach a denied file, unless the tool
  honours `.gitignore` and git reports the file as ignored.
- Rules of every kind match without regard to case. Deny rules see through wrappers
  (`env`, `command`, `nohup`, `time`, `nice`, `xargs`, `timeout`, `stdbuf`), shell
  keywords, parentheses and the program's path; allow rules never match by bare program
  name.
- Containment refuses an environment assignment or `env -S` before any decider sees the
  command, so an extension cannot let it through.
- The built-in allow list names whole commands (`npm test` and `npm test *`, not
  `npm test*`); `node --test` is allowed only without a file; `sed` only for scripts that
  print or filter; denies were added for `node` inline code and loaders, `git --output`,
  `sort -o`, `rg --pre`, branch deletion and forcing, and `.envrc`.
- The protected list gains credential stores, tool logins (`~/.config/gh`, `~/.config/gcloud`,
  `~/.azure`, `~/.git-credentials`), the agents' own configuration (`~/.claude.json`), shell
  history and keychains, and is shared with the Claude Code sandbox, which additionally
  refuses whatever the operator's `read:` deny rules name. System directories cannot be
  enrolled as workspaces.

### Fixed

- `portrail start` takes the lock on the data directory before assembling anything, so a
  refused second start no longer marks the running daemon's runs as `outcome_unknown`;
  a failed start leaves neither `daemon.lock` nor `daemon.json` behind.
- Runs left queued by a previous process are dispatched as soon as the next process has
  recovered.
- When the agent's process exits or its stream breaks after the turn began, the run ends
  as `outcome_unknown` and its session as `attention_required`; it was reported as `failed`.
- A decision that arrives after its run was cancelled or finished is refused and never
  reaches the agent.
- An extension named by `PORTRAIL_EXTENSION`, or an installed `@portrail/pro`, that cannot
  load stops `portrail start` with a clear message instead of silently running the
  built-in rules; `portrail doctor` reports it.
- A run's event stream delivers every event of the run and ends with its `run.completed`;
  events of other runs in the session no longer spend the delivery allowance, and a later
  run in the same session streams normally.
- SDK: `runs.wait()` and `runs.events()` honour an already-aborted signal, pass it to the
  request and leave no listeners behind; a caller's signal is combined with the request
  timeout instead of replacing it; `health()` sends the key.
- Request bodies are type-checked instead of coerced: a non-string `prompt` is a 400, not
  a run; a non-string `session` is a 400, not a 500; `metadata` is limited to 16 KiB.
- Unexpected server errors are logged with the request id the client receives.
- `GET /health` answers with `status` and `version` only unless the caller holds a key or
  the local token; agent readiness and the Pro status are no longer public behind a
  tunnel. `portrail status` sends the local token.
- `GET /v1/runs/:id/operations` returns 404 for an unknown run; an empty id no longer
  lists every operation. An idempotent retry of run creation returns the run as it
  stands now. The bearer scheme is accepted in any letter case. Local answers require a
  real loopback address. `run.maxSeconds` has the same bounds in config.json as on the API.
- `portrail run --json` exits 1 when the run did not succeed and 2 when something was
  refused, like the text mode; it always returned 0.
- Boolean CLI flags (`--json`, `--live`, `--insecure`, `--with-fake-agent`, `--follow`) no
  longer swallow the argument that follows them.
- An unknown `--tunnel` kind is refused before the daemon starts; a tunnel that fails to
  open closes the daemon and releases the lock.
- The systemd unit quotes every token; the service log follows the data directory chosen
  with `--home`.
- An extension whose event listener throws is reported on stderr instead of killing the
  daemon; `portrail start` shuts down once and in order on repeated signals or a fatal
  error.

### Changed

- Absolute paths outside the workspace are refused in commands, `/tmp` included; only
  `/dev/null` and similar devices are exempt.
- `node --test <file>`, `npm run` scripts other than the named ones, `git branch -D`/`-M`/`-f`,
  `sort -o`, `sed -i` and `sed` scripts with `w`, `r`, `e` or `-f` are no longer allowed by
  default.
- The SDK sends `Idempotency-Key` for run creation only.
- `.docker` is protected as a whole directory in the Claude Code sandbox (was `config.json` only).
- The `ajv` and `ajv-formats` dependencies, never used, are removed. The package declares
  macOS and Linux as supported platforms.
- Prettier is applied to the whole repository and checked in CI, alongside `npm audit`;
  the GitHub Actions in CI are pinned to commit SHAs.

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
