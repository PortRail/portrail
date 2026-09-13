import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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

const SCHEMA_VERSION = 2;

/**
 * Fields read straight out of the JSON so a query can filter on them without parsing
 * every row. Virtual generated columns: never written, always in step with `data`.
 */
const GENERATED: ReadonlyArray<readonly [column: string, path: string]> = [
  ["state", "$.state"],
  ["run_id", "$.runId"],
  ["hash", "$.hash"],
];
const generated = ([column, path]: readonly [string, string]) =>
  `${column} TEXT GENERATED ALWAYS AS (json_extract(data, '${path}')) VIRTUAL`;

const PRAGMAS = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=FULL;
PRAGMA secure_delete=ON;
`;

const TABLES = `
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT,
  data TEXT NOT NULL,
  ${GENERATED.map(generated).join(",\n  ")},
  PRIMARY KEY (kind, id)
);
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
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS records_session ON records(kind, session_id);
CREATE INDEX IF NOT EXISTS records_state ON records(kind, state);
CREATE INDEX IF NOT EXISTS records_run ON records(kind, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS records_hash ON records(kind, hash) WHERE hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS commands_created ON commands(created_at);
`;

/** What a query may filter on. Anything else never reaches SQL. */
export interface RecordFilter {
  sessionId?: string;
  state?: string | readonly string[];
  runId?: string;
  hash?: string;
}

export interface SelectOptions extends RecordFilter {
  /** Newest first by insertion; the default is oldest first, like list(). */
  newestFirst?: boolean;
  limit?: number;
  offset?: number;
}

const COLUMNS = {
  sessionId: "session_id",
  state: "state",
  runId: "run_id",
  hash: "hash",
} as const;

export class Store {
  readonly db: DatabaseSync;
  private transactions: Array<Array<() => void>> = [];

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);

    this.db.exec(PRAGMAS);
    this.migrate();

    if (!this.get("meta", "install"))
      this.put("meta", { id: "install", createdAt: now() });
  }

  /**
   * Bring the file to the current schema in one transaction. Structural, not
   * version-driven: whatever is missing is added, so a daemon and a CLI opening the
   * same file at once cannot get in each other's way — BEGIN IMMEDIATE serialises
   * them and the second finds nothing left to do.
   */
  private migrate() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { user_version } = this.db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (user_version > SCHEMA_VERSION)
        throw new Error(
          "This database was written by a newer version of Portrail. Upgrade Portrail or use a different PORTRAIL_HOME.",
        );
      this.db.exec(TABLES);
      const columns = new Set(
        (
          this.db
            .prepare("SELECT name FROM pragma_table_xinfo('records')")
            .all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
      for (const column of GENERATED)
        if (!columns.has(column[0]))
          this.db.exec(`ALTER TABLE records ADD COLUMN ${generated(column)}`);
      this.db.exec(INDEXES);
      if (user_version !== SCHEMA_VERSION)
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing was written.
      }
      this.db.close();
      throw /newer version/.test((error as Error).message)
        ? error
        : new Error(
            `Could not upgrade the database at ${this.path} to schema ${SCHEMA_VERSION}: ${(error as Error).message}`,
          );
    }
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
    return this.select<T>(kind, { sessionId });
  }

  private where(
    kind: string,
    filter: RecordFilter,
  ): { sql: string; params: SQLInputValue[] } {
    const clauses = ["kind=?"];
    const params: SQLInputValue[] = [kind];
    for (const key of Object.keys(COLUMNS) as Array<keyof RecordFilter>) {
      const value = filter[key];
      if (value === undefined) continue;
      if (typeof value === "string") {
        clauses.push(`${COLUMNS[key]}=?`);
        params.push(value);
      } else {
        clauses.push(`${COLUMNS[key]} IN (${value.map(() => "?").join(",")})`);
        params.push(...value);
      }
    }
    return { sql: clauses.join(" AND "), params };
  }

  /** Records of one kind matching the filter, in insertion order unless asked otherwise. */
  select<T = any>(kind: string, options: SelectOptions = {}): T[] {
    const { sql, params } = this.where(kind, options);
    let query = `SELECT data FROM records WHERE ${sql} ORDER BY rowid ${options.newestFirst ? "DESC" : "ASC"}`;
    if (options.limit !== undefined) {
      query += " LIMIT ? OFFSET ?";
      params.push(options.limit, options.offset ?? 0);
    }
    return (this.db.prepare(query).all(...params) as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as T,
    );
  }

  /** How many records match, without reading one. */
  count(kind: string, filter: RecordFilter = {}): number {
    const { sql, params } = this.where(kind, filter);
    return Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM records WHERE ${sql}`)
          .get(...params) as { n: number }
      ).n,
    );
  }

  findOne<T = any>(kind: string, filter: RecordFilter): T | undefined {
    return this.select<T>(kind, { ...filter, limit: 1 })[0];
  }

  /** One page, newest first, with the total the same filter matches. */
  page<T = any>(
    kind: string,
    filter: RecordFilter,
    limit: number,
    offset: number,
  ): { items: T[]; total: number } {
    return {
      items: this.select<T>(kind, { ...filter, newestFirst: true, limit, offset }),
      total: this.count(kind, filter),
    };
  }

  /** Delete every record of one kind for a session; returns how many went. */
  removeWhere(kind: string, filter: { sessionId: string }): number {
    const { sql, params } = this.where(kind, filter);
    return Number(
      this.db.prepare(`DELETE FROM records WHERE ${sql}`).run(...params).changes,
    );
  }

  removeEvents(sessionId: string): number {
    return Number(
      this.db.prepare("DELETE FROM events WHERE session_id=?").run(sessionId).changes,
    );
  }

  /** The whole event log in write order, for a follower that must not poll every session. */
  tailEvents(
    afterRow: number,
    limit = 200,
  ): Array<{ row: number; event: PortrailEvent }> {
    return (
      this.db
        .prepare(
          "SELECT rowid AS row, data FROM events WHERE rowid>? ORDER BY rowid LIMIT ?",
        )
        .all(afterRow, limit) as Array<{ row: number; data: string }>
    ).map(({ row, data }) => ({
      row: Number(row),
      event: JSON.parse(data) as PortrailEvent,
    }));
  }

  latestEventRow(): number {
    return Number(
      (
        this.db.prepare("SELECT COALESCE(MAX(rowid), 0) AS row FROM events").get() as {
          row: number;
        }
      ).row,
    );
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
