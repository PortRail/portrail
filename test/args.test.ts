import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flagBool,
  flagNumber,
  flagString,
  parseArgs,
} from "../src/cli/args.ts";

test("parses the command, positional arguments, and supported flag forms", () => {
  const args = parseArgs([
    "serve",
    "input.txt",
    "--host",
    "localhost",
    "--port=8080",
    "--verbose",
    "-q",
  ]);

  assert.equal(args.command, "serve");
  assert.deepEqual(args.positional, ["input.txt"]);
  assert.deepEqual(
    [...args.flags],
    [
      ["host", "localhost"],
      ["port", "8080"],
      ["verbose", true],
      ["q", true],
    ],
  );
});

test("treats everything after the double dash as positional", () => {
  const args = parseArgs(["run", "--trace", "--", "--literal", "-x", "file"]);

  assert.equal(args.command, "run");
  assert.deepEqual(args.positional, ["--literal", "-x", "file"]);
  assert.deepEqual([...args.flags], [["trace", true]]);
});

test("returns an empty command when there are no positional arguments", () => {
  const args = parseArgs(["--verbose"]);

  assert.equal(args.command, "");
  assert.deepEqual(args.positional, []);
  assert.deepEqual([...args.flags], [["verbose", true]]);
});

test("flag helpers return typed values and fallbacks", () => {
  const args = parseArgs([
    "serve",
    "--host=localhost",
    "--port",
    "8080",
    "--watch",
    "--enabled=true",
  ]);

  assert.equal(flagString(args, "host"), "localhost");
  assert.equal(flagString(args, "watch", "fallback"), "fallback");
  assert.equal(flagString(args, "missing", "fallback"), "fallback");
  assert.equal(flagNumber(args, "port"), 8080);
  assert.equal(flagNumber(args, "missing", 3000), 3000);
  assert.equal(flagBool(args, "watch"), true);
  assert.equal(flagBool(args, "enabled"), true);
  assert.equal(flagBool(args, "missing"), false);
});

test("flagNumber rejects non-numeric values", () => {
  const args = parseArgs(["serve", "--port=nope"]);

  assert.throws(() => flagNumber(args, "port"), /--port must be a number, got "nope"/);
});
