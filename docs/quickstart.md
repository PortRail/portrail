# Quickstart

Five minutes from nothing to an agent doing work through an API.

## 1. Install

```sh
npm install -g portrail
portrail doctor
```

`doctor` checks Node, finds your agents, and tells you exactly what to fix if something is
missing. A common one: an agent installed under a different Node version. `doctor` finds it
anyway and tells you how to pin the path.

## 2. Set up

```sh
portrail init
portrail workspace add ~/code/my-app --name my-app
portrail key create local
```

The key is printed once. Copy it somewhere safe; Portrail stores only a hash.

## 3. Start

```sh
portrail start
```

```
Portrail 0.1.0 listening on http://127.0.0.1:7431
  data:    /Users/you/.portrail
  agents:  codex, claude
  rules:   built-in allow/deny list
```

## 4. Your first run

From the terminal, the CLI is a client of the API like any other:

```sh
export PORTRAIL_KEY=prt_…
portrail run --workspace my-app "List the files here and tell me what this project does"
```

Or with curl, holding the connection until it is done:

```sh
curl -X POST http://127.0.0.1:7431/v1/runs \
  -H "Authorization: Bearer $PORTRAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "codex",
    "workspace": "my-app",
    "prompt": "Add a --version flag to the CLI and update the README",
    "wait": 600
  }'
```

You get back the run with its final state and the agent's summary:

```json
{
  "id": "run_…",
  "state": "succeeded",
  "summary": "Added --version to src/cli.ts and documented it in README.md.",
  "usage": { "inputTokens": 12073, "outputTokens": 512, "costUsd": null }
}
```

## 5. See what it did

```sh
curl http://127.0.0.1:7431/v1/runs/run_…/operations -H "Authorization: Bearer $PORTRAIL_KEY"
```

Every command and file change, with the verdict and the rule that produced it. Or from the
terminal:

```sh
portrail logs
```

## 6. When you want to be asked

The shipped rules say yes or no. For the commands in between, add a pattern to
`decide.ask` in `~/.portrail/config.json`:

```json
"ask": ["exec:*"]
```

Now `portrail run` stops and asks — `Allow this once? [y/N]` — for any command the lists
do not cover. From another terminal, `portrail status` shows what is waiting and
`portrail approve` / `portrail deny` answer it. Once only; see [docs/rules.md](rules.md).

## 7. Watch it live

Runs stream server-sent events. Follow one from the terminal with `portrail run` (it does
this for you), or from any SSE client:

```sh
curl -N http://127.0.0.1:7431/v1/runs/run_…/events -H "Authorization: Bearer $PORTRAIL_KEY"
```

## Next

- Tune the rules: [docs/rules.md](rules.md)
- Reach it from the internet: [docs/remote.md](remote.md)
- Keep it running: `portrail service install`
