/**
 * The Portrail client. Ships as `portrail/client` and is what `portrail run` uses,
 * so the CLI exercises the same code an integrator would.
 */

export interface PortrailClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Per-request deadline for ordinary calls. Streams and `wait` set their own. */
  timeoutMs?: number;
}

/** A pause that an abort ends at once, leaving no listener behind either way. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class PortrailClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PortrailClientError";
  }
}

export type AgentId = "codex" | "claude" | "fake";
export type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "outcome_unknown";

export interface Run {
  id: string;
  sessionId: string;
  state: RunState;
  model: string | null;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  deadlineAt: string;
  summary: string | null;
  cancellationRequested: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** total / allowed / denied / asked. A `succeeded` run with `denied > 0` did not do everything asked. */
  operations: { total: number; allowed: number; denied: number; asked: number };
  events: string;
}

export interface PortrailEvent {
  schemaVersion: string;
  sessionId: string;
  runId: string | null;
  seq: number;
  type: string;
  timestamp: string;
  data: Record<string, any>;
}

export interface CreateRun {
  prompt: string;
  workspace?: string;
  agent?: AgentId;
  session?: string;
  model?: string;
  maxSeconds?: number;
  /** Seconds to hold the response open. 0 returns immediately. */
  wait?: number;
}

interface Page<T> {
  items: T[];
  total: number;
  nextOffset?: number;
}

const TERMINAL = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

export class PortrailClient {
  private readonly base: string;

  constructor(readonly options: PortrailClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        "baseUrl must be a plain origin, without credentials, query or fragment.",
      );
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error(
        "Use https, or plain http only for loopback. API keys must not travel in the clear.",
      );
    this.base = options.baseUrl.replace(/\/+$/, "");
  }

  async request<T = any>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    // Only run creation is replayed safely by the server; a key must never be minted from a stored response.
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

    // A caller's signal adds a way to stop; it never removes the timeout.
    const timeout = AbortSignal.timeout(
      init.timeoutMs ?? this.options.timeoutMs ?? 30_000,
    );
    const response = await (this.options.fetch ?? fetch)(`${this.base}/v1${path}`, {
      method,
      headers,
      redirect: "error",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const isJson =
      /^application\/json/i.test(response.headers.get("content-type") ?? "") ||
      /^\s*[\[{]/.test(text);
    let payload: any = null;
    if (isJson) {
      try {
        payload = text.trim() ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
    }
    if (!response.ok)
      // A proxy in front of Portrail may answer with its own HTML (502, 504, a timeout
      // page). Surface that as a typed error with the status, never as a parse crash.
      throw new PortrailClientError(
        response.status,
        payload?.error?.code ??
          (response.status >= 500 ? "UPSTREAM_ERROR" : "HTTP_ERROR"),
        payload?.error?.message ??
          `Request failed with ${response.status}${
            text
              ? `: ${text
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 160)}`
              : "."
          }`,
        payload?.error?.details,
      );
    if (!isJson || payload === null)
      throw new PortrailClientError(
        502,
        "NOT_JSON",
        `Expected JSON from ${path} but got ${response.headers.get("content-type") ?? "no content type"}. Is a proxy in the way?`,
      );
    return payload as T;
  }

  readonly runs = {
    create: (input: CreateRun, options: { idempotencyKey?: string } = {}) =>
      this.request<Run>("/runs", {
        method: "POST",
        body: input,
        idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
        timeoutMs: (input.wait ?? 0) * 1000 + 30_000,
      }),
    get: (runId: string) => this.request<Run>(`/runs/${encodeURIComponent(runId)}`),
    list: (
      query: {
        session?: string;
        state?: RunState;
        limit?: number;
        offset?: number;
      } = {},
    ) =>
      this.request<Page<Run>>(
        `/runs?${new URLSearchParams(
          Object.entries(query)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]): [string, string] => [key, String(value)]),
        )}`,
      ),
    cancel: (runId: string) =>
      this.request<Run>(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: {},
      }),
    reply: (runId: string, text: string) =>
      this.request<Run>(`/runs/${encodeURIComponent(runId)}/reply`, {
        method: "POST",
        body: { text },
      }),
    /** Poll until the run ends. Prefer `events()` when you can hold a connection. */
    wait: async (
      runId: string,
      options: { intervalMs?: number; signal?: AbortSignal } = {},
    ) => {
      for (;;) {
        options.signal?.throwIfAborted();
        const run = await this.request<Run>(`/runs/${encodeURIComponent(runId)}`, {
          signal: options.signal,
        });
        if (TERMINAL.has(run.state)) return run;
        await sleep(options.intervalMs ?? 2000, options.signal);
      }
    },
    events: (
      runId: string,
      options: { after?: number; signal?: AbortSignal; reconnect?: boolean } = {},
    ) => this.stream(`/runs/${encodeURIComponent(runId)}/events`, options),
  };

  readonly sessions = {
    list: () => this.request<Page<any>>("/sessions"),
    get: (sessionId: string) =>
      this.request<any>(`/sessions/${encodeURIComponent(sessionId)}`),
    close: (sessionId: string) =>
      this.request<any>(`/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: "POST",
        body: {},
      }),
  };

  readonly workspaces = {
    list: () =>
      this.request<{
        items: Array<{ id: string; name: string; root: string; createdAt: string }>;
      }>("/workspaces"),
    add: (input: { name: string; root: string }) =>
      this.request<any>("/workspaces", { method: "POST", body: input }),
    remove: (ref: string) =>
      this.request<void>(`/workspaces/${encodeURIComponent(ref)}`, {
        method: "DELETE",
      }),
  };

  readonly agents = {
    list: () => this.request<{ items: any[] }>("/agents"),
  };

  readonly keys = {
    list: () => this.request<{ items: any[] }>("/keys"),
    create: (input: {
      name: string;
      scopes?: string[];
      expiresInDays?: number | null;
    }) => this.request<any>("/keys", { method: "POST", body: input }),
    revoke: (keyId: string) =>
      this.request<any>(`/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" }),
  };

  health() {
    return (this.options.fetch ?? fetch)(`${this.base}/health`, {
      redirect: "error",
      headers: { Authorization: `Bearer ${this.options.token}` },
    }).then((r) => r.json());
  }

  /** Resumable server-sent events with exponential backoff. */
  private async *stream(
    path: string,
    options: { after?: number; signal?: AbortSignal; reconnect?: boolean },
  ): AsyncGenerator<PortrailEvent> {
    let after = options.after ?? 0;
    let attempt = 0;
    // An abort simply ends the pause; the loop condition then exits.
    const pause = () =>
      sleep(
        Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) *
          (0.8 + Math.random() * 0.4),
        options.signal,
      ).catch(() => {});

    while (!options.signal?.aborted) {
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(
          `${this.base}/v1${path}?after=${after}`,
          {
            headers: { Authorization: `Bearer ${this.options.token}` },
            redirect: "error",
            signal: options.signal,
          },
        );
      } catch (error) {
        if (options.signal?.aborted) return;
        if (options.reconnect === false) throw error;
        await pause();
        continue;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        throw new PortrailClientError(
          response.status,
          payload.error?.code ?? "HTTP_ERROR",
          payload.error?.message ?? "Stream refused.",
        );
      }
      let sawTerminal = false;
      try {
        for await (const event of parseSSE(response.body!)) {
          if (event.seq > after) {
            after = event.seq;
            attempt = 0;
            yield event;
            if (event.type === "run.completed") sawTerminal = true;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        if (options.reconnect === false || /SSE|JSON/.test((error as Error).message))
          throw error;
      } finally {
        await response.body?.cancel().catch(() => {});
      }
      if (sawTerminal || options.reconnect === false) return;
      await pause();
    }
  }
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<PortrailEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      if (buffer.length > 4 * 1024 * 1024) throw new Error("SSE frame too large");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as PortrailEvent;
        if (!Number.isSafeInteger(event.seq) || typeof event.sessionId !== "string")
          throw new Error("Invalid SSE envelope");
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
