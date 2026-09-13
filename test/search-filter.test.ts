import { test } from "node:test";
import assert from "node:assert/strict";
import { expandBraces } from "../src/decide/filter.ts";

test("brace alternatives expand before matching, nested ones too, and unbalanced braces are refused", () => {
  assert.deepEqual(expandBraces("*.{ts,tsx}"), ["*.ts", "*.tsx"]);
  assert.deepEqual(expandBraces("{a,{b,c}}.js"), ["a.js", "b.js", "c.js"]);
  assert.deepEqual(expandBraces("plain.md"), ["plain.md"]);
  assert.deepEqual(expandBraces("src/{a,b}/*.{ts,js}"), [
    "src/a/*.ts",
    "src/a/*.js",
    "src/b/*.ts",
    "src/b/*.js",
  ]);
  assert.equal(expandBraces("*.{ts"), null);
  assert.equal(expandBraces("{}"), null);
  assert.equal(expandBraces("a}b"), null);
});
