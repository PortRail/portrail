import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const secret = () => randomBytes(32).toString("base64url");
export const now = () => new Date().toISOString();

/** Stable key order so a digest of the same data is always the same string. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value),
    )
    .digest("hex");

/** Constant-time compare for anything derived from a credential. */
export const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface PortrailEvent {
  schemaVersion: string;
  sessionId: string;
  runId: string | null;
  seq: number;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=FULL;
PRAGMA secure_delete=ON;
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS records_session ON records(kind, session_id);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS commands (
  principal TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  digest TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, route, key)
);
PRAGMA user_version=${SCHEMA_VERSION};
COMMIT;
`;

/**
 * A small record store on top of node:sqlite.
 *
 * Everything is a JSON document addressed by (kind, id). That keeps the schema
 * stable while the product's shapes move, and it is fast enough by a wide margin
 * for a single-operator gateway.
 */
export class Store {
  readonly db: DatabaseSync;
  private transactions: Array<Array<() => void>> = [];

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);

    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        "This database was written by a newer version of Portrail. Upgrade Portrail or use a different PORTRAIL_HOME.",
      );
    }
    this.db.exec(SCHEMA);

    if (!this.get("meta", "install"))
      this.put("meta", { id: "install", createdAt: now() });
  }

  /**
   * Synchronous transaction with savepoint nesting. Callbacks registered through
   * `afterCommit` only run once the outermost transaction has actually committed,
   * so an observer can never see state that later rolls back.
   */
  tx<T>(fn: () => T): T {
    const depth = this.transactions.length;
    const savepoint = `portrail_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    const callbacks: Array<() => void> = [];
    this.transactions.push(callbacks);

    let value: T;
    try {
      value = fn();
      if (value && typeof (value as { then?: unknown }).then === "function")
        throw new Error("Store transactions must be synchronous.");
      this.db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
    } catch (error) {
      this.transactions.pop();
      try {
        this.db.exec(
          depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK",
        );
      } catch {
        // A full disk can roll the transaction back on its own. Nothing to undo.
      }
      throw error;
    }

    this.transactions.pop();
    const parent = this.transactions[depth - 1];
    if (parent) parent.push(...callbacks);
    else for (const callback of callbacks) queueMicrotask(callback);
    return value;
  }

  afterCommit(callback: () => void) {
    const callbacks = this.transactions.at(-1);
    if (callbacks) callbacks.push(callback);
    else queueMicrotask(callback);
  }

  get<T = any>(kind: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  list<T = any>(kind: string, sessionId?: string): T[] {
    const sql = sessionId
      ? "SELECT data FROM records WHERE kind=? AND session_id=? ORDER BY rowid"
      : "SELECT data FROM records WHERE kind=? ORDER BY rowid";
    const rows = (
      sessionId
        ? this.db.prepare(sql).all(kind, sessionId)
        : this.db.prepare(sql).all(kind)
    ) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as T);
  }

  put<T extends { id: string; sessionId?: string | null }>(kind: string, record: T): T {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,session_id,data) VALUES(?,?,?,?) " +
          "ON CONFLICT(kind,id) DO UPDATE SET session_id=excluded.session_id, data=excluded.data",
      )
      .run(kind, record.id, record.sessionId ?? null, JSON.stringify(record));
    return record;
  }

  remove(kind: string, key: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, key);
  }

  /** Append one durable event and advance the session's sequence in the same transaction. */
  event(
    sessionId: string,
    type: string,
    data: Record<string, unknown> = {},
    runId?: string,
  ): PortrailEvent {
    return this.tx(() => {
      const session = this.get<{
        id: string;
        lastEventSeq: number;
        lastActivityAt?: string;
      }>("session", sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}`);

      const seq = ++session.lastEventSeq;
      session.lastActivityAt = now();
      this.put("session", session);

      const event: PortrailEvent = {
        schemaVersion: "1.0.0",
        sessionId,
        runId: runId ?? null,
        seq,
        type,
        timestamp: now(),
        data,
      };
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?,?)")
        .run(sessionId, seq, event.timestamp, JSON.stringify(event));
      return event;
    });
  }

  events(sessionId: string, after = 0, limit = 1000): PortrailEvent[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(sessionId, after, limit) as Array<{ data: string }>
    ).map((row) => JSON.parse(row.data) as PortrailEvent);
  }

  earliestEvent(sessionId: string): number | null {
    const row = this.db
      .prepare("SELECT MIN(seq) AS seq FROM events WHERE session_id=?")
      .get(sessionId) as { seq: number | null };
    return row.seq;
  }

  close() {
    this.db.close();
  }
}
