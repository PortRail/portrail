# Contributing

Thanks for looking. Portrail is small on purpose, and the rules below keep it that way.

## Before you start

- **Security problems go to [SECURITY.md](SECURITY.md)**, not to an issue.
- Open an issue before a large change. A short "I want to do X because Y" saves both of us a rewrite.
- Node 24+. `npm install`, then `npm test` (deterministic, no agents needed) and `npm run typecheck`.

## What a good change looks like

- One thing per pull request.
- A test that fails before and passes after. `test/` uses `node:test`; the fake agent in `src/providers/fake/` lets you exercise the whole engine without inference.
- Plain-English test names that say what is true, not what function is called.
- No new runtime dependencies without a reason in the PR description. The install is 14 MB and compiles nothing; keep it so.
- Comments explain *why*, when the code cannot. They do not narrate the code.

## Where things live

| Folder | What |
|---|---|
| `src/core/` | sessions, runs, the decision seam (`gateway.ts` — `decide()` is the heart), recovery |
| `src/decide/` | the free allow/deny decider |
| `src/providers/` | Codex, Claude Code, the fake agent |
| `src/server/` | the HTTP API |
| `src/cli/` | the command line |
| `src/extension.ts` | the seam Portrail Pro plugs into — changing it is a breaking change |
| `docs/` | user documentation; `security.md` is the threat model and must stay true |

## Running against real agents

`npm run e2e` drives both agents for real and costs inference. Run it before a PR that touches `src/providers/`.

## Licence

MIT. By contributing you agree your contribution is licensed the same way.
