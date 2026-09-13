# API reference

Base URL: `http://127.0.0.1:7431` by default. Every route under `/v1` needs
`Authorization: Bearer prt_…` (the scheme is case-insensitive), except the two local-answer
routes described below, which take `X-Portrail-Local`. Bodies are JSON objects and their
fields are type-checked: `prompt` must be a string; `session`, `workspace`, `agent`,
`model` and `callback` strings when present; `maxSeconds` a number from 30 to 14400;
`metadata` an object of at most 16 KiB (**413** otherwise). Errors look like:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "This key does not have the runs:write scope.",
    "retryable": false
  }
}
```

`retryable: true` means trying again later can help (queue full, too many streams or held
waits, a locked-out address, shutting down).

## Runs

### `POST /v1/runs` — start work `runs:write`

```json
{
  "agent": "codex", // or "claude"; omit "session" to start a new one
  "workspace": "my-app", // name or id
  "prompt": "Fix the failing test",
  "session": "ses_…", // optional: continue an earlier conversation instead
  "model": "gpt-5.6-sol", // optional: must be one the agent offers
  "maxSeconds": 900, // optional: 30–14400
  "wait": 300 // optional: hold the response up to this many seconds
}
```

Without `wait`: **202** with the run in state `queued`. With `wait`: the connection is
held, whitespace is sent every 15 s so proxies keep it open, and the answer is **200** with
the run as it stands when the run ends or the wait expires — check `state` in the body,
not the status code. Send an
`Idempotency-Key` header (8–200 characters) and a retry with the same key and body returns
the same run **as it stands now**; a different body with the same key is a
**409 `IDEMPOTENCY_CONFLICT`**. Only this route honours the header. A key may hold twenty
`wait=` responses at once (**429 `TOO_MANY_WAITS`** for the next); a caller that
disconnects frees its slot.

Run states: `queued` → `starting` → `running` ⇄ `waiting_for_approval` → `succeeded` |
`failed` | `cancelled` | `outcome_unknown`. Also `cancelling` while a cancel is in flight.

`outcome_unknown` means Portrail lost track of the agent after handing it the work — the
agent's process exited, its stream broke, or Portrail itself restarted. Part of the work
may have happened. Nothing is retried automatically; the session is marked
`attention_required` and refuses new runs until you start a fresh one.

Every run carries `operations: { total, allowed, denied, asked }`. A `succeeded` run with
`denied > 0` finished, but your rules refused something along the way — the summary says
what. `portrail run` exits 2 in that case.

### `GET /v1/runs` `runs:read`

`?session=ses_…&state=succeeded&limit=50&offset=0`. Newest first.

### `GET /v1/runs/:id` `runs:read`

### `GET /v1/runs/:id/operations` `runs:read`

Every operation the agent asked about, with the decision, the rule, who decided, and when.

### `GET /v1/operations/pending` and `POST /v1/operations/:id/answer` — local only

The free tier's "ask". When an operation matches `decide.ask`, the run pauses with
state `waiting_for_approval`, emits `approval.requested`, and waits for an answer from
**this machine**: `portrail approve <id>` / `portrail deny <id>`, or `portrail run`'s own
prompt. Behind those commands are these two routes. They take no API key; the credential
is `X-Portrail-Local: <token>` with the token the daemon wrote to `daemon.json` (mode
0600). Body: `{"verdict": "allow" | "deny", "by": "name"}`. The answer applies once; the
operation is recorded as decided by `local:<by>`. An unanswered ask is refused after
`approvals.timeoutMinutes`.

Portrail Pro adds `/v1/approvals` for decisions from anywhere, with scopes and links.

### `GET /v1/runs/:id/events` — server-sent events `runs:read`

```
id: 7
event: command.started
data: {"schemaVersion":"1.0.0","sessionId":"ses_…","runId":"run_…","seq":7,"type":"command.started","timestamp":"…","data":{"command":"npm test","cwd":"/…"}}
```

Resume with `Last-Event-ID: 7` or `?after=7`. Every event has a sequence number; you will
never miss one or see one twice. The stream always ends with the run's own
`run.completed`. Delivery is paced at 100 events per second per session, so a long
replay takes a moment rather than being cut short. `?all=true` also includes other runs
in the same session.

Event types: `run.queued` `run.state_changed` `run.started` `run.steered` `run.completed`
`output.text` `output.reasoning` `operation.requested` `operation.decided`
`approval.requested` `command.started` `command.output` `command.finished`
`files.changed` `diff` `usage` `warning`.

A cursor behind the retention window gets **410 `EVENTS_EXPIRED`** — fetch the run instead.
Twenty streams per key (**429 `TOO_MANY_STREAMS`**).

### `POST /v1/runs/:id/cancel` `runs:write`

Asks the agent to stop; if it does not within five seconds, it is stopped. A cancel that
lands after the agent already finished leaves `succeeded` and sets `cancellationRequested`.

### `POST /v1/runs/:id/reply` `runs:write`

`{"text": "Use the existing helper instead"}` — steer a running Codex turn. For a Claude
Code run this returns **409 `NOT_SUPPORTED`**: cancel and start a new run in the same
session; the agent keeps its context.

## Sessions

A session is one conversation with one agent in one workspace. Runs in the same session
share context; the agent remembers earlier runs.

- `GET /v1/sessions` `runs:read`
- `GET /v1/sessions/:id` `runs:read` — includes its runs
- `POST /v1/sessions/:id/close` `runs:write`

## Workspaces

- `GET /v1/workspaces` `runs:read`
- `POST /v1/workspaces` `workspaces:admin` — `{"name":"my-app","root":"/abs/path"}`
- `DELETE /v1/workspaces/:nameOrId` `workspaces:admin`

## Agents

`GET /v1/agents` `runs:read` — what is installed, signed in, ready, and which auth it uses.
Codex is always checked through its app-server (`verified: true`, no inference). Claude's
readiness is read from credentials on disk (`verified: false`) so this route is cheap; add
`?deep=true` to ask Claude for a real completion (one small call).

## Keys

- `GET /v1/keys` `keys:admin`
- `POST /v1/keys` `keys:admin` — `{"name":"zapier","scopes":["runs:write","runs:read"],"expiresInDays":90}`.
  The response carries `token` — the only time it is ever visible.
- `DELETE /v1/keys/:id` `keys:admin` — revoke. A key cannot revoke itself.

Scopes: `runs:write` `runs:read` `approvals:decide` `workspaces:admin` `policy:admin`
`keys:admin`, or `*`.

## Health

`GET /health` — `{"status":"ok","version":"…"}` without a credential, for monitors. Send a
key (any scope) or `X-Portrail-Local` to also get `agents` and `pro`; a wrong key is a 401.

Ten wrong keys from one address within a minute answer **429 `TOO_MANY_FAILURES`** with a
`Retry-After` header for the rest of the minute, on every route; `/health` without a
credential is still answered. A request must arrive within 30 s and a connection idle for
60 s is closed.

## Portrail Pro adds

`/v1/policy`, `/v1/policy/test`, `/v1/approvals`, `POST /v1/approvals/:id`, `/v1/audit`,
`/v1/machines`, and `callback` on `POST /v1/runs` for webhooks.
