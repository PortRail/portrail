import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

/** An error the agent's runtime returned, as opposed to one we caused locally. */
export class NativeError extends Error {
  constructor(
    message: string,
    readonly nativeCode: number,
  ) {
    super(message);
    this.name = "NativeError";
  }
}

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcOptions {
  executable?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Cap on a single protocol line. Generous on purpose: a cumulative turn diff or a
   * large file change arrives as one line, and a 1 MiB ceiling breaks on exactly
   * that once the agent is allowed to actually edit files.
   */
  maxLineBytes?: number;
  /** Default per-call deadline. Approval-bearing calls pass their own. */
  defaultTimeoutMs?: number;
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio.
 *
 * Framing is strict and fails closed: an oversized line, invalid UTF-8, a malformed
 * envelope or a truncated tail kills the connection rather than letting a partially
 * understood message reach the caller.
 */
export class CodexRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private faulted = false;
  closed = false;
  /** stderr is kept for diagnostics; the agent writes real errors there. */
  stderrTail = "";

  constructor(private options: RpcOptions = {}) {
    super();
    const maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;

    this.child =
      options.args && options.executable === undefined
        ? (() => {
            throw new Error("An executable is required when args are supplied.");
          })()
        : spawn(options.executable ?? "codex", options.args ?? [], {
            stdio: ["pipe", "pipe", "pipe"],
            env: options.env ?? {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              USER: process.env.USER,
              TMPDIR: process.env.TMPDIR,
              ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
            },
          });

    let fragments: Buffer[] = [];
    let buffered = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });

    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.faulted || this.closed) return;
      let offset = 0;
      while (offset < chunk.length && !this.faulted) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const fragment = chunk.subarray(offset, end);

        if (buffered + fragment.length > maxLineBytes) {
          fragments = [];
          buffered = 0;
          this.fault(
            `Agent sent a line over the ${Math.round(maxLineBytes / 1024 / 1024)} MiB limit.`,
          );
          return;
        }
        fragments.push(fragment);
        buffered += fragment.length;
        if (newline === -1) return;

        let message: RpcMessage;
        try {
          message = JSON.parse(decoder.decode(Buffer.concat(fragments, buffered)));
          if (!isEnvelope(message)) throw new Error("bad envelope");
        } catch {
          fragments = [];
          buffered = 0;
          this.fault("Agent sent a message this version cannot parse.");
          return;
        }
        fragments = [];
        buffered = 0;
        offset = newline + 1;
        this.dispatch(message);
      }
    });

    this.child.stdout.on("end", () => {
      if (buffered && !this.faulted) this.fault("Agent output ended mid-message.");
    });
    this.child.stdin.on("error", () => this.fault("Agent stopped reading input."));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
    });
    this.child.on("error", (error) => this.emit("fault", error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      const reason = new Error(
        `Agent process exited (${signal ?? `code ${code}`}).${
          this.stderrTail ? ` Last output: ${this.stderrTail.trim().slice(-500)}` : ""
        }`,
      );
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(reason);
      }
      this.pending.clear();
      this.emit("exit", code, signal);
    });
  }

  private dispatch(message: RpcMessage) {
    if (process.env.PORTRAIL_DEBUG_RPC)
      process.stderr.write(
        `[rpc<-] ${message.method ?? `response#${message.id}`}${message.id !== undefined && message.method ? ` #${message.id}` : ""} ${JSON.stringify(message.params ?? message.result ?? message.error ?? "").slice(0, 300)}\n`,
      );
    try {
      if (message.method === undefined) {
        const entry = this.pending.get(message.id as number);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id as number);
        if (message.error)
          entry.reject(new NativeError(message.error.message, message.error.code));
        else entry.resolve(message.result);
        return;
      }
      // A method with an id is a request from the agent: it wants an answer.
      if (message.id !== undefined) this.emit("request", message);
      else this.emit("notification", message);
    } catch (error) {
      this.fault(`Failed to handle an agent message: ${(error as Error).message}`);
    }
  }

  private fault(message: string) {
    if (this.faulted || this.closed) return;
    this.faulted = true;
    this.child.stdout.destroy();
    const error = new Error(message);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit("fault", error);
    this.close(true);
  }

  /**
   * Send a request and wait for its response.
   *
   * The default deadline is deliberately long. Once the agent is allowed to work,
   * a call can sit behind a human approval, and a 30-second timeout would turn an
   * attentive operator into a protocol error.
   */
  call<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed || this.faulted)
      return Promise.reject(new Error("The agent connection is closed."));
    if (process.env.PORTRAIL_DEBUG_RPC)
      process.stderr.write(`[rpc->] ${method} ${JSON.stringify(params ?? "").slice(0, 300)}\n`);

    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const deadline = timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent did not answer "${method}" within ${deadline} ms.`));
      }, deadline);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown) {
    if (this.closed || this.faulted) return;
    this.child.stdin.write(
      JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + "\n",
    );
  }

  /** Answer a request the agent made of us. */
  respond(id: string | number, result: unknown) {
    if (this.closed || this.faulted) return;
    this.child.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  /** Refuse a request we do not implement. */
  refuse(id: string | number, message = "Unsupported request; refused by Portrail") {
    if (this.closed || this.faulted) return;
    this.child.stdin.write(
      JSON.stringify({ id, error: { code: -32601, message } }) + "\n",
    );
  }

  close(force = false) {
    if (this.closed) return;
    this.child.kill(force ? "SIGKILL" : "SIGTERM");
    if (force) return;
    const timer = setTimeout(() => {
      if (!this.closed) this.child.kill("SIGKILL");
    }, 2000);
    timer.unref();
  }
}

function isEnvelope(message: unknown): message is RpcMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const envelope = message as RpcMessage;
  if (
    envelope.id !== undefined &&
    typeof envelope.id !== "string" &&
    !Number.isSafeInteger(envelope.id)
  )
    return false;

  if (envelope.method !== undefined)
    return typeof envelope.method === "string" && envelope.method.length > 0;

  // A response must have an id and exactly one of result or error.
  if (envelope.id === undefined) return false;
  if (Object.hasOwn(envelope, "result") === Object.hasOwn(envelope, "error")) return false;
  if (Object.hasOwn(envelope, "error")) {
    const error = envelope.error;
    return (
      !!error &&
      typeof error === "object" &&
      typeof error.message === "string" &&
      Number.isInteger(error.code)
    );
  }
  return true;
}
