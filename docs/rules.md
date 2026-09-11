# Rules

The free version decides with three lists in `~/.portrail/config.json`:

```json
{
  "decide": {
    "allow": ["read:**", "write:**", "exec:npm test*", "exec:git status*"],
    "deny":  ["read:.env*", "write:.env*", "exec:sudo *", "exec:curl *", "net:*"],
    "ask":   []
  }
}
```

**Deny wins. Allow passes. Ask stops and asks you. Anything unmatched is refused.**

## Ask: the third answer

Put a pattern in `ask` and a matching operation does not fail — the run pauses and
someone at this machine answers, once, for that operation only:

```json
"ask": ["exec:*"]
```

```
$ portrail run "deploy the docs"
$ make deploy   (in /Users/you/site)
  Matches exec:*; waiting for an answer at this machine.
  Allow this once? [y/N] y
  allowed
```

- `portrail run` asks right in the terminal. A run started any other way — `curl`,
  Make.com, the SDK — waits until someone on this machine runs `portrail approve` or
  `portrail deny` (`portrail status` shows what is waiting).
- **Once.** Nothing is remembered and no rule is written; the same command asks again
  next time. To stop being asked, add it to `allow` (or `deny`).
- **Only from this machine.** The credential is a token in `~/.portrail/daemon.json`
  (mode 0600), not an API key. A full-scope key over a tunnel cannot answer.
- **Never forever.** An unanswered ask is refused after `approvals.timeoutMinutes`
  (default 15). That is why the shipped `ask` list is empty: a run driven from Make.com
  has nobody at the terminal, and a 15-minute stall per unknown command is worse than a
  clear refusal.

A command is asked about only when every segment is covered by `allow` or `ask`; a
segment nobody would allow (`terraform apply && sudo ls`) makes the whole line a refusal,
not a question. Substitutions and redirects stay refused whatever the lists say.

Portrail Pro is what happens after the question: answer from anywhere (a signed link in
Slack or email, the API from another machine), as someone else, with `run` / `session`
/ `always` scopes, and every answer in the audit log.

## The five operations

| Kind | The agent wants to… | Matched against |
|---|---|---|
| `read` | read a file | canonical path, relative to the workspace |
| `write` | create, change or delete a file | canonical path, relative to the workspace |
| `exec` | run a command | each segment of the command line |
| `net` | reach the network | host |
| `tool` | call a custom MCP tool | `server/tool` |

Before any rule runs, every path is canonicalised (symlinks followed) and must be inside
the workspace; `~/.ssh`, the agent config directories and Portrail's own data directory are
refused everywhere. No rule can override that.

## How commands are judged

A command line is split on `&&`, `||`, `;`, `|`, `&` and newlines, and **every segment
must match an allow rule (or an ask rule, which makes the line a question); any segment
matching a deny refuses the whole line.** Quotes are removed before matching, so
`cat ~/".ssh"/id_"rsa"` is judged as `cat ~/.ssh/id_rsa`.

Some things cannot be judged by matching text, so they are refused whatever the lists
say — the reason names them:

| in the command | why it is refused |
|---|---|
| `$(…)`, backticks, `<(…)` | command substitution: another command hides inside |
| `>`, `>>`, `2>file` | a redirect turns any command into a write. `2>/dev/null` and `2>&1` discard or merge output and are fine |
| `$VAR`, `${VAR}`, `$1`, `$'…'` | variable expansion: the path is not the text |
| `~user`, `{a,b}`, `{1..3}` | tilde and brace expansion: the shell makes words the rule never sees |
| `*`, `?`, `[` outside quotes | a glob: the shell picks the files, not the rule |
| `NODE_OPTIONS=… tsc`, `PATH=… git status` | an environment assignment can change what an allowed command does. `CI`, `NODE_ENV`, `FORCE_COLOR`, `NO_COLOR`, `TZ`, `LANG`, `LC_ALL`, `DEBUG`, `TERM` and `COLUMNS` are harmless and ignored |

All of this happens before any rule — and before any extension — runs. So does the
path check: a command's working directory and every argument are resolved the way the
shell would (`~/…` from home, everything else against the working directory) and held
against the protected list, so `cat src/../../.zshrc` is refused just like
`cat ~/.zshrc`. `~/.ssh`, the shell's own dotfiles, the agents' configuration and
Portrail's data directory are refused everywhere.

| command | verdict | why |
|---|---|---|
| `npm test && npm run build` | allow | both segments allowed |
| `ls; curl http://evil` | deny | `curl` segment is denied |
| `sed -n '1,40p' a.ts \| sort` | allow | both are read-only tools |
| `cat x $(rm -rf ~)` | deny | command substitution cannot be judged by text |
| `echo hi > out.txt` | deny | a redirect turns a read into a write |
| `CI=1 npm test` | allow | a harmless env prefix is ignored |
| `FOO=1 npm test` | deny | an unknown assignment can change what the command does |

Codex wraps commands in `/bin/zsh -lc '…'`; Portrail strips that wrapper first, so
`exec:cat *` means the same thing for both agents.

## Patterns

Paths use file globs: `*` stops at a slash, `**` crosses them, `**/x` also matches `x` at
the root. Path matching ignores case, because APFS and NTFS do.

Commands use a simpler glob where `*` matches anything within a segment:
`exec:git commit *` matches `git commit -m "fix"`.

## The defaults

Reads and writes inside the workspace are free, except secret files (`.env*`, `*.pem`,
`id_rsa*`, `id_ed25519*`) which are refused for both. Package scripts by name (`npm test`,
`npm run build|lint|typecheck|check`, `pnpm`/`yarn` equivalents), `node --test`, `tsc`, the
safe `git` subcommands, and the usual read-only tools (`ls`, `cat`, `head`, `tail`,
`sed -n`, `rg`, `grep`, `find`, `wc`, `sort`, `which`, `command -v` …) are free.

Refused: commands touching `.ssh`, `.aws`, `.env`, `.pem`, `id_rsa`, `credentials`;
`sudo`/`su`/`doas`; `rm -rf` of `/`, `~` or `$HOME`; `shutdown`/`reboot`/`mkfs`/`dd`;
publishing (`npm publish`, `cargo publish`, …) and `git push`; network commands (`curl`,
`wget`, `ssh`, `scp`, `nc`); inline code (`python -c`, `node -e`, `sh -c`, `eval`); and all
`net` operations. Everything else is refused too — add what you need.

**Deliberately not allowed:** `node <file>` and `npm run <anything>`. Either runs whatever
the agent wrote a moment earlier. Allow them explicitly if you accept that.

## Trying a rule

Start a run with the fake agent and watch the decisions:

```sh
portrail start --with-fake-agent
curl -X POST http://127.0.0.1:7431/v1/runs -H "Authorization: Bearer $PORTRAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent":"fake","workspace":"my-app","wait":5,"prompt":"[{\"exec\":\"terraform apply\"}]"}'
```

Portrail Pro adds `portrail policy test exec "terraform apply"`, which prints the matching
rule and the verdict through the same code path as a live decision.
