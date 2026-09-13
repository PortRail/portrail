import { ensure } from "../contracts/errors.ts";
import { digest, id as newId, now, secret, type Store } from "../store/index.ts";

export const SCOPES = [
  "runs:write",
  "runs:read",
  "approvals:decide",
  "workspaces:admin",
  "policy:admin",
  "keys:admin",
] as const;
export type Scope = (typeof SCOPES)[number];

export interface KeyRecord {
  id: string;
  name: string;
  /** SHA-256 of the token. The token itself is shown once and never stored. */
  hash: string;
  scopes: Scope[] | ["*"];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Rules attached to this key. Only Pro reads it; it can only narrow. */
  policy: unknown;
}

export interface Principal {
  keyId: string;
  name: string;
  scopes: KeyRecord["scopes"];
}

const PREFIX = "prt_";

export class Keys {
  constructor(private readonly store: Store) {}

  create(input: {
    name: string;
    scopes?: readonly string[];
    expiresInDays?: number | null;
    policy?: unknown;
  }): { key: KeyRecord; token: string } {
    ensure(
      typeof input.name === "string" &&
        /^[a-z0-9][a-z0-9-_ .]{0,63}$/i.test(input.name),
      400,
      "INVALID_REQUEST",
      "Key name must be 1–64 characters: letters, digits, dashes, dots, spaces.",
    );
    const scopes = input.scopes ?? ["*"];
    ensure(
      Array.isArray(scopes) &&
        scopes.length > 0 &&
        scopes.every(
          (scope) => scope === "*" || (SCOPES as readonly string[]).includes(scope),
        ),
      400,
      "INVALID_REQUEST",
      `Scopes must be "*" or some of: ${SCOPES.join(", ")}.`,
    );
    const days = input.expiresInDays ?? null;
    ensure(
      days === null || (Number.isInteger(days) && days >= 1 && days <= 3650),
      400,
      "INVALID_REQUEST",
      "expiresInDays must be 1–3650, or omitted for no expiry.",
    );

    const token = PREFIX + secret();
    const key: KeyRecord = {
      id: newId("key"),
      name: input.name,
      hash: digest(token),
      scopes: scopes.includes("*") ? ["*"] : (scopes as Scope[]),
      createdAt: now(),
      expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      policy: input.policy ?? null,
    };
    this.store.put("key", key);
    return { key, token };
  }

  list(): KeyRecord[] {
    return this.store.list<KeyRecord>("key");
  }

  get(keyId: string): KeyRecord {
    const key = this.store.get<KeyRecord>("key", keyId);
    ensure(key, 404, "NOT_FOUND", "Key not found.");
    return key;
  }

  revoke(keyId: string): KeyRecord {
    const key = this.get(keyId);
    if (key.revokedAt) return key;
    return this.store.put("key", { ...key, revokedAt: now() });
  }

  /** Resolve a bearer token to a principal, or throw 401. */
  authenticate(token: string | undefined): Principal {
    ensure(
      typeof token === "string" &&
        token.startsWith(PREFIX) &&
        token.length > PREFIX.length + 20,
      401,
      "UNAUTHORIZED",
      "A valid API key is required. Send it as `Authorization: Bearer prt_...`.",
    );
    const hash = digest(token);
    const key = this.store
      .list<KeyRecord>("key")
      .find((candidate) => candidate.hash === hash);
    ensure(key, 401, "UNAUTHORIZED", "Unknown API key.");
    ensure(!key.revokedAt, 401, "KEY_REVOKED", "This API key was revoked.");
    ensure(
      !key.expiresAt || Date.parse(key.expiresAt) > Date.now(),
      401,
      "KEY_EXPIRED",
      "This API key has expired.",
    );
    // Touch at most once a minute; every request would be a write per call.
    if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 60_000)
      this.store.put("key", { ...key, lastUsedAt: now() });
    return { keyId: key.id, name: key.name, scopes: key.scopes };
  }

  static allows(principal: Principal, scope: Scope): boolean {
    const scopes = principal.scopes as readonly string[];
    return scopes.includes("*") || scopes.includes(scope);
  }
}

/** A key record without its hash — safe to return from the API. */
export function publicKey(key: KeyRecord) {
  const { hash, ...rest } = key;
  void hash;
  return { ...rest, tokenPreview: `${PREFIX}…` };
}
