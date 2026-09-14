import { test } from "node:test";
import assert from "node:assert/strict";
import { isPortrailError, PortrailError } from "../src/contracts/errors.ts";

/**
 * An extension may be built against its own copy of the core, so its errors are not
 * `instanceof` ours. They are still Portrail errors: recognise them by their shape.
 */
function lookAlike(status: number, code: string): Error {
  return Object.assign(new Error("from another copy"), {
    name: "PortrailError",
    status,
    code,
    details: {},
    toJSON() {
      return { error: { code, message: "from another copy", retryable: false } };
    },
  });
}

test("isPortrailError recognises the class, a look-alike from another copy, and nothing else", () => {
  assert.ok(isPortrailError(new PortrailError(404, "NOT_FOUND", "gone")));
  assert.ok(isPortrailError(lookAlike(418, "TEAPOT")));
  assert.ok(!isPortrailError(new Error("plain")));
  assert.ok(!isPortrailError({ status: 500 }));
  assert.ok(!isPortrailError(Object.assign(new Error("x"), { name: "PortrailError" })));
  assert.ok(!isPortrailError(null));
});
