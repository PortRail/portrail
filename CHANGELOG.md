# Changelog

All notable changes to Portrail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.1.5] — 2026-09-15

### Security

- A workspace's own git credentials are protected like the credential stores outside it.
  Naming `.git/config`, `.git/credentials`, `.git-credentials` or a submodule's config is
  refused, and a search that would open one (`rg --hidden`, `grep -r`) is
  refused when the file carries a credential: a token or password in a web URL, an
  `http.extraheader` a CI checkout left behind, or a stored password. `git` itself keeps
  working. Before, a search's judgement skipped `.git`, so `rg --hidden TOKEN .` could
  print a token from a remote URL, and `cat .git/config` was allowed.

### Added

- `decide.reachLimit` in `config.json` sets how many files a search may reach before it is
  refused instead of judged: an integer from 100 to 1 000 000, 20 000 by default. The
  refusal names the ways out: a subdirectory, the tool's own filters, or this setting.
- `portrail prune --days 0 --yes` removes every finished session. It needs `--yes` because
  an installed extension prunes its own records with the same cutoff.
- `docs/continuity.md` says what happens to the core and to Pro if the maintainer stops;
  `docs/agent-terms.md` quotes the agents' terms with the date they were read. The README
  says which login to use.

### Changed

- The retention pass keeps the last day of retry records, which hold only a run id,
  whatever the window, so a client retrying right after a prune is not handed a second run.

### Fixed

- `docs/security.md` and `docs/rules.md` state that a search's judgement leaves
  `node_modules` out, and `docs/security.md` says how Codex's and Claude Code's logins are
  actually handled.

## [0.1.4] — 2026-09-15

### Fixed

- Codex 0.149 and later refuse `approval_policy = "untrusted"` in their configuration
  file, so Codex exited before the first operation. The managed Codex home no longer
  writes that line, and existing managed homes drop it. Every thread start and resume
  still asks for `untrusted` with the `user` reviewer, and Portrail refuses to start a
  turn when Codex answers with anything weaker. The prompt rules are unchanged. Checked
  live with Codex CLI 0.147 and 0.154.

### Changed

- The package is compiled with TypeScript 7.

## [0.1.3] — 2026-09-14

### Security

- The sed and search checks now judge a program by its name, however it was spelled.
  `SED -n 1w/tmp/x f`, `RG --hidden KEY`, `Grep -r KEY .` and `/usr/bin/rg --hidden`
  matched the case-insensitive allow rules but skipped those checks, so on a
  case-insensitive filesystem they could write a file or read `.env`.

### Added

- `portrail/extension` exports the analysis the built-in decider judges from
  (`analyseOperation` with its types) plus `parseCommand`, `containOperation`,
  `parsePattern`, `recursiveReadOf`, `bearerToken`, `isPortrailError`, `AuthGuard` and
  the `SearchFilter`/`SearchGlob` types, so an extension's decider judges the same facts
  instead of parsing the command line again.
- A backslash in a rule makes the character after it literal: `read:report\?.txt`
  names that one file.

### Fixed

- An error raised by an extension built against its own copy of the core (the
  `PORTRAIL_EXTENSION` development setup, or a global install beside a global
  `portrail`) kept becoming a 500. Portrail errors are now recognised by their shape.
- An installed extension whose own dependency could not be imported was treated as
  "not installed" and the daemon started on the built-in rules. Only the extension
  module itself being absent means that now; anything else stops the start with the
  import error.

## [0.1.2] — 2026-09-13

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

### Added

- `portrail prune [--days n]` runs retention on demand and reports what it removed. It is
  safe next to a running gateway: sessions with an active run are kept.
- Extensions can implement `onRetention(cutoff, host)` to prune their own records with the
  same cutoff the core used.

### Fixed

- Retention now runs when the daemon starts, not only an hour later, so sessions that
  piled up while no daemon ran are removed before it listens. A session's records are
  deleted in bulk.
- When a token refresh replaced the Codex login link under `~/.portrail/codex` with a
  regular file, every later Codex run failed with `EEXIST` and the token stayed inside
  the data directory. Portrail now moves a newer token back to the real `auth.json`,
  drops an identical or older copy, and restores the link.
- A tunnel URL that arrived split across two output chunks, or without a trailing
  newline, was not recognised and the start timed out. Tunnel output is now read line
  by line per stream.
- `scripts/install-test.sh` picks a free port instead of assuming 7499.

### Changed

- Dependabot keeps the pinned GitHub Actions in CI current.
- Runs, operations and keys are found through indexed columns instead of reading every
  record: creating a run, dispatching the queue, answering a permission question,
  authenticating a key and listing runs or operations no longer slow down as history
  grows. The database upgrades itself to schema 2 the first time it is opened; an older
  Portrail then refuses to open it.
- `GET /v1/runs` and `GET /v1/sessions` filter and page in the database; the response
  shape is unchanged.
- `portrail logs -f` follows one cursor over the event log instead of polling every
  session.

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
