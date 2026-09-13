import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { ensure, fail, PortrailError } from "../contracts/errors.ts";
import type { Gateway } from "../core/gateway.ts";
import { Keys, publicKey, type Principal, type Scope } from "../core/keys.ts";
import type { RunRecord } from "../core/records.ts";
import { obj, optNum, optStr, str } from "./body.ts";
import type { Extension, ExtensionHost } from "../extension.ts";
import { digest, equal, id as newId, now, type Store, type PortrailEvent } from "../store/index.ts";
import { TERMINAL_STATES, type AgentId } from "../types.ts";
import { API_PREFIX, version } from "../runtime.ts";
import { SessionEventPacer } from "./event-pacer.ts";

export interface ServerOptions {
  gateway: Gateway;
  store: Store;
  keys: Keys;
  dataDir: string;
  extension?: Extension | null;
  /** Shared with the daemon so routes and the extension see one host. Built if absent. */
  host?: ExtensionHost;
  tls?: { cert: string; key: string } | null;
  /** True when bound beyond loopback without TLS — allowed only with --insecure. */
  insecure?: boolean;
  /**
   * The credential for answering a parked operation from this machine. It lives in
   * daemon.json (mode 0600), never in a key, so only someone who can read the data
   * directory can answer — the free tier's "ask" is answered here or not at all.
   */
  localToken?: string | null;
  agentStatus: (deep?: boolean) => Promise<unknown[]>;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const RUN_VIEW_FIELDS: Array<keyof RunRecord> = [
  "id",
  "sessionId",
  "state",
  "model",
  "createdAt",
  "startedAt",
  "completedAt",
  "deadlineAt",
  "summary",
  "cancellationRequested",
  "usage",
  "operations",
];

export function runView(run: RunRecord) {
  const view: Record<string, unknown> = {};
  for (const field of RUN_VIEW_FIELDS) view[field] = run[field];
  view.prompt = run.prompt.length > 2000 ? run.prompt.slice(0, 2000) + "…" : run.prompt;
  view.events = `${API_PREFIX}/runs/${run.id}/events`;
  return view;
}

export async function createApp(options: ServerOptions): Promise<FastifyInstance> {
  const { gateway, store, keys } = options;
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 0,
    connectionTimeout: 0,
    keepAliveTimeout: 65_000,
    ...(options.tls
      ? { https: { cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) } }
      : {}),
  });
  const pacer = new SessionEventPacer();
  const streams = new Map<string, number>();

  // Clients routinely send Content-Type: application/json on a bodiless DELETE or
  // POST. Treat an empty body as an empty object instead of a 400.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    if (!payload || (typeof payload === "string" && payload.trim() === "")) return done(null, {});
    try {
      done(null, JSON.parse(payload as string));
    } catch (error) {
      done(Object.assign(error as Error, { statusCode: 400 }), undefined);
    }
  });

  // ------------------------------------------------------------ plumbing

  app.addHook("onRequest", async (_request, reply) => {
    reply.headers({
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Portrail-Version": version,
    });
  });

  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof PortrailError) return reply.code(error.status).send(error.toJSON());
    const status = error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : error.statusCode === 415 ? 415 : 500;
    return reply.code(status).send({
      error: {
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_REQUEST" : status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INTERNAL_ERROR",
        message:
          status === 500
            ? "Portrail could not complete the request."
            : (error.message ?? "Malformed request."),
        retryable: false,
        requestId: newId("req"),
      },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "No such route.", retryable: false } }),
  );

  const bearer = (request: FastifyRequest) => {
    const header = request.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  };

  /** Authenticate and check one scope. Attaches the principal to the request. */
  const auth = (request: FastifyRequest, scope: Scope): Principal => {
    const principal = keys.authenticate(bearer(request));
    ensure(
      Keys.allows(principal, scope),
      403,
      "FORBIDDEN",
      `This key does not have the ${scope} scope.`,
    );
    request.principal = principal;
    return principal;
  };

  const body = (request: FastifyRequest): Record<string, unknown> => {
    const value = request.body ?? {};
    ensure(typeof value === "object" && !Array.isArray(value), 400, "INVALID_REQUEST", "The request body must be a JSON object.");
    return value as Record<string, unknown>;
  };
  const params = (request: FastifyRequest) => request.params as Record<string, string>;

  /**
   * Durable idempotency for commands. The same key with the same body returns the
   * stored response; the same key with a different body is a conflict. Automations
   * retry, and a retried "start a run" must never start two.
   */
  function idempotent<T>(request: FastifyRequest, principal: string, execute: () => T): T {
    const key = request.headers["idempotency-key"];
    if (key === undefined) return execute();
    ensure(
      typeof key === "string" && key.length >= 8 && key.length <= 200,
      400,
      "INVALID_REQUEST",
      "Idempotency-Key must be 8–200 characters.",
    );
    const route = `${request.method} ${request.url.split("?")[0]}`;
    const hash = digest(request.body ?? {});
    return store.tx(() => {
      const previous = store.db
        .prepare("SELECT digest, response FROM commands WHERE principal=? AND route=? AND key=?")
        .get(principal, route, key) as { digest: string; response: string } | undefined;
      if (previous) {
        ensure(
          previous.digest === hash,
          409,
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used with a different request body.",
        );
        return JSON.parse(previous.response) as T;
      }
      const result = execute();
      store.db
        .prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)")
        .run(principal, route, key, hash, JSON.stringify(result), now());
      return result;
    });
  }

  function paginate<T>(request: FastifyRequest, items: T[]) {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50));
    const offset = Math.max(0, Number(query.offset ?? 0) || 0);
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}),
    };
  }

  // -------------------------------------------------------------- health

  app.get("/health", async () => ({
    status: "ok",
    version,
    agents: await options.agentStatus().then((agents) =>
      (agents as Array<{ id: string; ready: boolean }>).map((agent) => ({ id: agent.id, ready: agent.ready })),
    ),
    pro: options.extension ? { name: options.extension.name, version: options.extension.version, ...(options.extension.status?.(options.dataDir) ?? { active: true, detail: "" }) } : null,
  }));

  // ---------------------------------------------------------------- runs

  app.post(`${API_PREFIX}/runs`, async (request, reply) => {
    const principal = auth(request, "runs:write");
    const input = body(request);
    const wait = input.wait === undefined ? 0 : Number(input.wait);
    ensure(
      Number.isFinite(wait) && wait >= 0 && wait <= 3600,
      400,
      "INVALID_REQUEST",
      "wait must be 0–3600 seconds.",
    );

    // Validate before the idempotency lookup, so a malformed retry cannot replay a stored run.
    const callback = optStr(input, "callback");
    const create = {
      sessionId: optStr(input, "session"),
      workspace: optStr(input, "workspace"),
      agent: optStr(input, "agent") as AgentId | undefined,
      prompt: optStr(input, "prompt") ?? "",
      model: optStr(input, "model"),
      maxSeconds: optNum(input, "maxSeconds"),
      keyId: principal.keyId,
      // Fields the free core carries for Pro: callback URL and anything under metadata.
      metadata: {
        ...(obj(input, "metadata", { maxBytes: 16 * 1024 }) ?? {}),
        ...(callback !== undefined ? { callback } : {}),
      },
    };
    const run = idempotent(request, principal.keyId, () => gateway.createRun(create));

    if (!wait) return reply.code(202).send(runView(run));

    // Hold the response until the run ends or the caller's patience does. This is
    // what lets a Zapier or Make step call Portrail synchronously. Proxies cut idle
    // connections (Cloudflare at 100 s), so send a whitespace byte every 15 s —
    // leading whitespace is valid JSON — and always answer 200 with the state in
    // the body: a client cannot learn the outcome from a status code that had to
    // be chosen before the run ended.
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Portrail-Wait": "1" });
    const keepalive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write("\n");
    }, 15_000);
    keepalive.unref();
    try {
      await waitForRun(gateway, run.id, wait * 1000);
    } finally {
      clearInterval(keepalive);
    }
    if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify(runView(gateway.run(run.id))));
    return;
  });

  app.get(`${API_PREFIX}/runs`, async (request) => {
    auth(request, "runs:read");
    const query = request.query as Record<string, string | undefined>;
    return paginate(
      request,
      gateway
        .listRuns(query.session)
        .filter((run) => !query.state || run.state === query.state)
        .map(runView),
    );
  });

  app.get(`${API_PREFIX}/runs/:runId`, async (request) => {
    auth(request, "runs:read");
    return runView(gateway.run(params(request).runId!));
  });

  app.post(`${API_PREFIX}/runs/:runId/cancel`, async (request) => {
    auth(request, "runs:write");
    return runView(await gateway.cancel(params(request).runId!));
  });

  app.post(`${API_PREFIX}/runs/:runId/reply`, async (request) => {
    auth(request, "runs:write");
    await gateway.steer(params(request).runId!, str(body(request), "text"));
    return runView(gateway.run(params(request).runId!));
  });

  app.get(`${API_PREFIX}/runs/:runId/operations`, async (request) => {
    auth(request, "runs:read");
    return { items: gateway.listOperations({ runId: params(request).runId! }) };
  });

  // ------------------------------------------------------- local answers

  // Free's one human control: allow or refuse a parked operation, once, from this
  // machine. No bearer key opens this route; the token from daemon.json does, and
  // it is written by the daemon for the person who can read its data directory.
  const localOnly = (request: FastifyRequest) => {
    const given = request.headers["x-portrail-local"];
    const expected = options.localToken;
    ensure(typeof expected === "string" && expected.length > 0, 404, "NOT_FOUND", "No such route.");
    ensure(equal(typeof given === "string" ? given : "", expected), 403, "FORBIDDEN", "Answers are accepted only from this machine (X-Portrail-Local from daemon.json).");
    // Belt and braces: even with the token, the connection itself must be local.
    const from = request.socket?.remoteAddress ?? "";
    ensure(from === "127.0.0.1" || from === "::1" || from === "::ffff:127.0.0.1" || from === "", 403, "FORBIDDEN", "Answers are accepted only over the loopback interface.");
  };

  app.get(`${API_PREFIX}/operations/pending`, async (request) => {
    localOnly(request);
    return { items: gateway.listOperations({ state: "pending" }) };
  });

  app.post(`${API_PREFIX}/operations/:operationId/answer`, async (request) => {
    localOnly(request);
    const input = body(request);
    ensure(input.verdict === "allow" || input.verdict === "deny", 400, "INVALID_REQUEST", 'verdict must be "allow" or "deny".');
    const who = typeof input.by === "string" && input.by.trim() ? input.by.trim().slice(0, 64) : "terminal";
    const verdict = input.verdict as "allow" | "deny";
    gateway.resolve(
      params(request).operationId!,
      { verdict, reason: `${verdict === "allow" ? "Allowed" : "Refused"} once at this machine by ${who}.`, rule: "ask", scope: "once" },
      `local:${who}`,
    );
    return gateway.listOperations().find((op) => op.id === params(request).operationId) ?? fail(404, "NOT_FOUND", "Operation not found.");
  });

  // -------------------------------------------------------------- events

  app.get(`${API_PREFIX}/runs/:runId/events`, async (request, reply) => {
    const principal = auth(request, "runs:read");
    const run = gateway.run(params(request).runId!);
    const session = gateway.session(run.sessionId);
    const query = request.query as Record<string, string | undefined>;
    const lastEventId = request.headers["last-event-id"];

    for (const [label, value] of [["Last-Event-ID", lastEventId], ["after", query.after]] as const)
      ensure(
        value === undefined || (typeof value === "string" && /^\d+$/.test(value)),
        400,
        "INVALID_CURSOR",
        `${label} must be a whole number.`,
      );
    let seq = Number(lastEventId ?? query.after ?? 0);
    ensure(seq <= session.lastEventSeq, 400, "INVALID_CURSOR", "Cursor is ahead of the stream.");
    const earliest = store.earliestEvent(session.id);
    ensure(
      earliest === null || seq >= earliest - 1,
      410,
      "EVENTS_EXPIRED",
      "Those events have been retained past their window. Fetch the run instead.",
    );
    ensure(
      (streams.get(principal.keyId) ?? 0) < 20,
      429,
      "TOO_MANY_STREAMS",
      "This key already has 20 open event streams.",
    );
    streams.set(principal.keyId, (streams.get(principal.keyId) ?? 0) + 1);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`: portrail ${version}\n\n`);

    const onlyThisRun = query.all !== "true";
    let buffered: PortrailEvent[] = [];
    const nextEvent = () => {
      if (!buffered.length) buffered = store.events(session.id, seq, 100);
      return buffered.shift();
    };
    const finished = () => TERMINAL_STATES.has(store.get<RunRecord>("run", run.id)?.state ?? "outcome_unknown");
    // Writes at most one event per call and says so. Events that are not this run's
    // are consumed silently and never count against the session's allowance, so a
    // long earlier run cannot starve a later one. The stream ends itself once this
    // run's run.completed is on the wire — no timers guessing when that was.
    const delivery = pacer.subscribe(session.id, () => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return false;
      for (;;) {
        const next = nextEvent();
        if (!next) {
          // Replay exhausted with the run already over and its run.completed behind the
          // cursor: nothing more will ever come.
          if (onlyThisRun && finished()) reply.raw.end();
          return false;
        }
        seq = next.seq;
        if (onlyThisRun && next.runId !== run.id) continue;
        reply.raw.write(`id: ${next.seq}\nevent: ${next.type}\ndata: ${JSON.stringify(next)}\n\n`);
        if ((onlyThisRun && next.type === "run.completed") || reply.raw.writableLength > 1024 * 1024) reply.raw.end();
        return true;
      }
    });

    const onEvent = (event: PortrailEvent) => {
      if (event.sessionId === session.id) delivery.wake();
    };
    gateway.on("event", onEvent);
    delivery.wake();

    const heartbeat = setInterval(() => {
      try {
        keys.authenticate(bearer(request));
        reply.raw.write(": ping\n\n");
      } catch {
        reply.raw.end();
      }
    }, 15_000);
    heartbeat.unref();

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      delivery.close();
      gateway.off("event", onEvent);
      streams.set(principal.keyId, Math.max(0, (streams.get(principal.keyId) ?? 1) - 1));
    });
  });

  // ------------------------------------------------------------ sessions

  app.get(`${API_PREFIX}/sessions`, async (request) => {
    auth(request, "runs:read");
    return paginate(request, gateway.listSessions());
  });
  app.get(`${API_PREFIX}/sessions/:sessionId`, async (request) => {
    auth(request, "runs:read");
    const session = gateway.session(params(request).sessionId!);
    return { ...session, runs: gateway.listRuns(session.id).map(runView) };
  });
  app.post(`${API_PREFIX}/sessions/:sessionId/close`, async (request) => {
    auth(request, "runs:write");
    return gateway.closeSession(params(request).sessionId!);
  });

  // ---------------------------------------------------------- workspaces

  app.get(`${API_PREFIX}/workspaces`, async (request) => {
    auth(request, "runs:read");
    return { items: gateway.listWorkspaces() };
  });
  app.post(`${API_PREFIX}/workspaces`, async (request, reply) => {
    auth(request, "workspaces:admin");
    const input = body(request);
    return reply.code(201).send(gateway.addWorkspace({ name: str(input, "name"), root: str(input, "root") }));
  });
  app.delete(`${API_PREFIX}/workspaces/:ref`, async (request, reply) => {
    auth(request, "workspaces:admin");
    gateway.removeWorkspace(params(request).ref!);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------- agents

  app.get(`${API_PREFIX}/agents`, async (request) => {
    auth(request, "runs:read");
    const deep = (request.query as Record<string, string | undefined>).deep === "true";
    return { items: await options.agentStatus(deep) };
  });

  // ---------------------------------------------------------------- keys

  app.get(`${API_PREFIX}/keys`, async (request) => {
    auth(request, "keys:admin");
    return { items: keys.list().map(publicKey) };
  });
  app.post(`${API_PREFIX}/keys`, async (request, reply) => {
    auth(request, "keys:admin");
    const input = body(request);
    const created = keys.create({
      name: str(input, "name"),
      scopes: input.scopes as string[] | undefined,
      expiresInDays: optNum(input, "expiresInDays") ?? null,
      policy: input.policy,
    });
    // The only time the token is ever visible.
    return reply.code(201).send({ ...publicKey(created.key), token: created.token });
  });
  app.delete(`${API_PREFIX}/keys/:keyId`, async (request) => {
    const principal = auth(request, "keys:admin");
    ensure(params(request).keyId !== principal.keyId, 409, "SELF_REVOKE", "A key cannot revoke itself.");
    return publicKey(keys.revoke(params(request).keyId!));
  });

  // ----------------------------------------------------------- extension

  if (options.extension?.routes) {
    const host: ExtensionHost = options.host ?? {
      version,
      dataDir: options.dataDir,
      store,
      gateway,
      options: {},
      resolve: (operationId, decision, actor) => gateway.resolve(operationId, decision, actor),
    };
    await options.extension.routes(app, host);
  }

  app.addHook("onClose", async () => pacer.dispose());
  return app;
}

function waitForRun(gateway: Gateway, runId: string, timeoutMs: number): Promise<boolean> {
  if (TERMINAL_STATES.has(gateway.run(runId).state)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      gateway.off("event", onEvent);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onEvent = (event: PortrailEvent) => {
      if (event.runId === runId && event.type === "run.completed") {
        clearTimeout(timer);
        gateway.off("event", onEvent);
        resolve(true);
      }
    };
    gateway.on("event", onEvent);
  });
}

