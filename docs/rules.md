# Rules

The free version decides with three lists in `~/.portrail/config.json`:

```json
{
  "decide": {
    "allow": ["read:**", "write:**", "exec:npm test*", "exec:git status*"],
    "deny": ["read:.env*", "write:.env*", "exec:sudo *", "exec:curl *", "net:*"],
    "ask": []
  }
}
```

**Deny wins. Allow passes. Ask stops and asks you. Anything unmatched is refused.**
Matching ignores case for every kind, because the filesystem the commands run on does,
and so do the sed and search checks: `SED`, `/usr/bin/rg` and `Grep -r` are judged as
`sed`, `rg` and `grep`.

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

| Kind    | The agent wants to…             | Matched against                           |
| ------- | ------------------------------- | ----------------------------------------- |
| `read`  | read a file                     | canonical path, relative to the workspace |
| `write` | create, change or delete a file | canonical path, relative to the workspace |
| `exec`  | run a command                   | each segment of the command line          |
| `net`   | reach the network               | host                                      |
| `tool`  | call a custom MCP tool          | `server/tool`                             |

Before any rule runs, every path — declared, or named as a command argument — is
canonicalised (symlinks followed, on-disk spelling) and must be inside the workspace;
`~/.ssh`, credential stores, shell history, the agent config directories and Portrail's
own data directory are refused everywhere. So are the workspace's own git credentials:
naming `.git/config`, `.git/credentials`, `.git-credentials` or a submodule's config under
`.git/modules` is refused, and a search that would open one is refused when the file really
carries a credential — a token or password in a remote URL, the auth header a CI checkout
leaves behind, or a stored password. An ordinary repository's config refuses nothing, and
`git` itself runs as before. No rule can override any of that.

`node_modules` is deliberately left out of a search's judgement: walking it would cost more
than the limit allows. A search may therefore read what a dependency ships without that
being judged; naming such a file is still refused by the rules.

## How commands are judged

A command line is split on `&&`, `||`, `;`, `|`, `&`, `(`, `)` and newlines, and **every
segment must match an allow rule (or an ask rule, which makes the line a question); any
segment matching a deny refuses the whole line.** Quotes are removed before matching, so
`cat ~/".ssh"/id_"rsa"` is judged as `cat ~/.ssh/id_rsa`.

Deny rules also see each segment with wrappers removed — `env`, `command`, `exec`,
`nohup`, `time`, `nice`, `xargs`, `timeout`, `stdbuf` and shell keywords such as `if`,
`then` and `!` — and with the program reduced to its name, so `exec:curl *` refuses
`env curl …`, `(curl …)` and `/usr/bin/curl …` alike. Allow rules match the line as
written or with wrappers removed, never by bare program name: `./bin/git status` is not
`git status`.

Some things cannot be judged by matching text, so they are refused whatever the lists
say — the reason names them:

| in the command                            | why it is refused                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$(…)`, backticks, `<(…)`                 | command substitution: another command hides inside                                                                                                                                             |
| `>`, `>>`, `2>file`                       | a redirect turns any command into a write. `2>/dev/null` and `2>&1` discard or merge output and are fine                                                                                       |
| `$VAR`, `${VAR}`, `$1`, `$'…'`            | variable expansion: the path is not the text                                                                                                                                                   |
| `~user`, `{a,b}`, `{1..3}`                | tilde and brace expansion: the shell makes words the rule never sees                                                                                                                           |
| `*`, `?`, `[` outside quotes              | a glob: the shell picks the files, not the rule                                                                                                                                                |
| `NODE_OPTIONS=… tsc`, `PATH=… git status` | an environment assignment can change what an allowed command does. `CI`, `NODE_ENV`, `FORCE_COLOR`, `NO_COLOR`, `TZ`, `LANG`, `LC_ALL`, `DEBUG`, `TERM` and `COLUMNS` are harmless and ignored |

All of this happens before any rule — and before any extension — runs. So does the
path check: a command's working directory and every argument that names something on
disk are resolved the way the shell would (`~/…` from home, everything else against the
working directory), must lie inside the workspace, and are held against the protected
list; `cat src/../../.zshrc`, `cat /etc/passwd` and `ls ~` are refused alike. Every file
a command names is then judged by the `read:` deny rules under its real path, and a
search over a directory (`grep -r`, `rg`, `diff -r`, Claude's Grep) is judged by every
file it can reach: `grep -r KEY .` is refused in a workspace with a `.env` — search a
narrower path. A tool that honours `.gitignore` (`rg`, Claude's Grep) is not charged
with files git ignores, because it never opens them. A search that says what it opens
is judged by that: `rg -g '*.ts'`, `rg -t ts`, `grep -r --include='*.ts'` and Claude's
Grep with `glob` or `type` are not charged with a `.env` they would never open. Portrail
reads the filters the way the tool does — the last matching glob wins, a glob without a
slash matches a name at any depth, one with a slash is relative to the working
directory — and when it cannot be sure (character classes, a file type it does not know,
`--type-add`) it judges the whole directory as before. Naming the secret file itself, as
in `--exclude=.env`, is still a read of it. Only content is protected this way: `ls`,
`find` and Glob still list a denied file's name, and `git log -p` or `git show` print
whatever was committed.

| command                       | verdict | why                                                    |
| ----------------------------- | ------- | ------------------------------------------------------ |
| `npm test && npm run build`   | allow   | both segments allowed                                  |
| `ls; curl http://evil`        | deny    | `curl` segment is denied                               |
| `sed -n '1,40p' a.ts \| sort` | allow   | both are read-only tools                               |
| `cat x $(rm -rf ~)`           | deny    | command substitution cannot be judged by text          |
| `echo hi > out.txt`           | deny    | a redirect turns a read into a write                   |
| `CI=1 npm test`               | allow   | a harmless env prefix is ignored                       |
| `FOO=1 npm test`              | deny    | an unknown assignment can change what the command does |

Codex wraps commands in `/bin/zsh -lc '…'`; Portrail strips that wrapper first, so
`exec:cat *` means the same thing for both agents.

## Patterns

Paths use file globs: `*` stops at a slash, `**` crosses them, `**/x` also matches `x` at
the root.

Commands use a simpler glob where `*` matches anything, including the rest of a word:
`exec:git commit *` matches `git commit -m "fix"`, and `exec:npm test*` would also match
`npm testx`. Write `exec:npm test` and `exec:npm test *` to mean the command with and
without arguments. All matching ignores case. In both dialects a backslash makes the
character after it literal: `read:report\?.txt` names that one file.

## The defaults

Reads and writes inside the workspace are free, except secret files (`.env*`, `.envrc`,
`*.pem`, `id_rsa*`, `id_ed25519*`) which are refused for both. Package scripts by name
(`npm test`, `npm run build|lint|typecheck|check`, `pnpm`/`yarn` equivalents), `node --test`
on its own, `tsc`, the read-only `git` subcommands, and the usual read-only tools (`ls`,
`cat`, `head`, `tail`, `sed` for scripts that only print or filter, `rg`, `grep`, `find`,
`wc`, `sort`, `which`, `command -v` …) are free.

Refused: commands touching `.ssh`, `.aws`, `.env`, `.pem`, `id_rsa`, `credentials`;
`sudo`/`su`/`doas`; `rm -rf` of `/`, `~` or `$HOME`; `shutdown`/`reboot`/`mkfs`/`dd`;
publishing (`npm publish`, `cargo publish`, …) and `git push`; network commands (`curl`,
`wget`, `ssh`, `scp`, `nc`); inline code (`python -c`, `node -e`, `sh -c`, `eval`); and all
`net` operations. Everything else is refused too — add what you need.

**Deliberately not allowed:** `node <file>` (including `node --test <file>`), `npm run
<anything>` other than the scripts named above, `git branch` forms that delete, move or
force, `git --output`, `sort -o`, and `sed` scripts that do more than print or filter (`w`,
`r`, `e`, `-i`, `-f`). Each of these runs or writes whatever the agent produced a moment
earlier. Allow them explicitly if you accept that.

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
