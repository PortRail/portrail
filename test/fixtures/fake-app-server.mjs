// A stand-in for `codex app-server --stdio`: enough JSON-RPC to test framing and
// request/response plumbing without any inference. Behaviour is driven by env vars.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "normal";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");

if (mode === "garbage") {
  process.stdout.write("this is not json\n");
} else if (mode === "oversized") {
  process.stdout.write(JSON.stringify({ method: "big", params: { blob: "x".repeat(3 * 1024 * 1024) } }) + "\n");
} else if (mode === "truncated") {
  process.stdout.write('{"method":"half","params":{"a":');
  setTimeout(() => process.exit(0), 50);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "echo") {
    // Split the response across two writes with a multibyte character on the seam.
    const payload = JSON.stringify({ id: message.id, result: { text: "héllo → wörld ✓" } }) + "\n";
    const bytes = Buffer.from(payload, "utf8");
    const cut = bytes.indexOf(Buffer.from("→")) + 1; // inside the 3-byte arrow
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 5);
    return;
  }
  if (message.method === "coalesced") {
    // Two complete messages in one write, plus a notification.
    process.stdout.write(
      JSON.stringify({ method: "note", params: { n: 1 } }) + "\n" +
      JSON.stringify({ id: message.id, result: { ok: true } }) + "\n",
    );
    return;
  }
  if (message.method === "ask-me") {
    // The server asks the client something and relays the client's answer.
    write({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    const relay = message.id;
    globalThis.__relay = relay;
    return;
  }
  if (message.id === "srv-1" && message.result) {
    write({ id: globalThis.__relay, result: { clientSaid: message.result } });
    return;
  }
  if (message.method === "never-answer") return;
  if (message.method === "native-error") {
    write({ id: message.id, error: { code: -32600, message: "bad request from fake" } });
    return;
  }
  if (message.method === "die") process.exit(3);
});
