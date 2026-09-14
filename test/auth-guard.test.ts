import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthGuard } from "../src/server/auth-guard.ts";
import { bearerToken } from "../src/server/bearer.ts";

function guard(overrides: { limit?: number; windowMs?: number } = {}) {
  let now = 1_000_000;
  const lines: string[] = [];
  const g = new AuthGuard({
    ...overrides,
    now: () => now,
    log: (line) => lines.push(line),
  });
  return { g, lines, advance: (ms: number) => (now += ms) };
}

test("ten failed authentications within a minute lock an address out for the rest of it", () => {
  const { g, advance } = guard();
  for (let i = 0; i < 9; i++)
    g.failed("203.0.113.5", "UNAUTHORIZED", "GET", "/v1/runs");
  assert.equal(g.retryAfter("203.0.113.5"), 0, "nine is not yet too many");
  g.failed("203.0.113.5", "UNAUTHORIZED", "GET", "/v1/runs");
  const wait = g.retryAfter("203.0.113.5");
  assert.ok(wait > 0 && wait <= 60, `locked for the rest of the minute, got ${wait}`);
  advance(30_000);
  assert.ok(g.retryAfter("203.0.113.5") <= 30, "the wait shrinks as the minute passes");
  advance(31_000);
  assert.equal(
    g.retryAfter("203.0.113.5"),
    0,
    "free again once the first failure is a minute old",
  );
});

test("addresses are counted apart, and the log names the address, code and route but never a token", () => {
  const { g, lines } = guard();
  for (let i = 0; i < 10; i++)
    g.failed(
      "203.0.113.5",
      "UNAUTHORIZED",
      "GET",
      "/v1/runs?token=prt_secret_should_not_appear",
    );
  g.failed("203.0.113.6", "KEY_REVOKED", "POST", "/v1/runs");
  assert.equal(g.retryAfter("203.0.113.6"), 0);
  assert.equal(
    lines.filter((line) =>
      line.startsWith("auth failed from 203.0.113.5: UNAUTHORIZED GET /v1/runs"),
    ).length,
    10,
  );
  assert.equal(lines.filter((line) => /locked out/.test(line)).length, 1);
  assert.ok(
    lines.some((line) => line.includes("203.0.113.6: KEY_REVOKED POST /v1/runs")),
  );
  assert.ok(
    !lines.some((line) => line.includes("prt_secret")),
    "query strings are cut before logging",
  );
});

test("a locked address is not counted further, so hammering does not extend the lockout", () => {
  const { g, advance } = guard();
  for (let i = 0; i < 10; i++)
    g.failed("203.0.113.5", "UNAUTHORIZED", "GET", "/v1/runs");
  const first = g.retryAfter("203.0.113.5");
  advance(20_000);
  for (let i = 0; i < 50; i++)
    g.failed("203.0.113.5", "UNAUTHORIZED", "GET", "/v1/runs");
  assert.ok(
    g.retryAfter("203.0.113.5") <= first - 20,
    "the window still ends a minute after the first failure",
  );
});

test("old addresses are forgotten so the table cannot grow without bound", () => {
  const { g, advance } = guard();
  for (let i = 0; i < 10_050; i++)
    g.failed(`10.0.${Math.floor(i / 250)}.${i % 250}`, "UNAUTHORIZED", "GET", "/");
  advance(61_000);
  g.failed("203.0.113.9", "UNAUTHORIZED", "GET", "/");
  assert.ok(g.size <= 2, `expired addresses were swept, ${g.size} remain`);
});

test("bearerToken reads the scheme in any case and refuses anything else", () => {
  assert.equal(bearerToken("Bearer x"), "x");
  assert.equal(bearerToken("bearer x"), "x");
  assert.equal(bearerToken("BEARER  x "), "x");
  assert.equal(bearerToken("Basic x"), undefined);
  assert.equal(bearerToken("Bearer"), undefined);
  assert.equal(bearerToken("Bearer a b"), undefined);
  assert.equal(bearerToken(""), undefined);
  assert.equal(bearerToken(undefined), undefined);
});
