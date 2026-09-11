# SDK

```ts
import { PortrailClient } from "portrail/client";

const client = new PortrailClient({ baseUrl: "http://127.0.0.1:7431", token: process.env.PORTRAIL_KEY! });

const run = await client.runs.create({
  agent: "codex",
  workspace: "my-app",
  prompt: "Add input validation to the signup form",
});

for await (const event of client.runs.events(run.id)) {
  if (event.type === "output.text") process.stdout.write(event.data.text);
  if (event.type === "operation.decided" && event.data.verdict === "deny")
    console.error(`refused: ${event.data.reason}`);
}

const final = await client.runs.get(run.id);
console.log(final.state, final.summary);
```

- `runs.create(input, { idempotencyKey })` — pass your own key for safe retries; one is
  generated otherwise.
- `runs.events(id, { after, signal, reconnect })` — resumable; reconnects with backoff
  and never yields an event twice.
- `runs.wait(id)` — poll until done, for callers that cannot hold a stream.
- `runs.cancel`, `runs.reply`, `sessions.*`, `workspaces.*`, `agents.list`, `keys.*`.

The client refuses plain `http` to anything but loopback, so a key cannot be sent in the
clear by accident. `portrail run` is built on this same client.
