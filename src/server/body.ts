import { ensure } from "../contracts/errors.ts";

/**
 * Request bodies are checked, never coerced: `{prompt: {}}` is a 400, not a run
 * whose prompt is "[object Object]". Each helper names the field in its message.
 */
type Input = Record<string, unknown>;

const absent = (value: unknown) => value === undefined || value === null;

export function optStr(input: Input, field: string): string | undefined {
  const value = input[field];
  if (absent(value)) return undefined;
  ensure(typeof value === "string", 400, "INVALID_REQUEST", `${field} must be a string.`);
  return value;
}

export function str(input: Input, field: string): string {
  const value = optStr(input, field);
  ensure(value !== undefined, 400, "INVALID_REQUEST", `${field} is required.`);
  return value;
}

export function optNum(input: Input, field: string): number | undefined {
  const value = input[field];
  if (absent(value)) return undefined;
  ensure(typeof value === "number" && Number.isFinite(value), 400, "INVALID_REQUEST", `${field} must be a number.`);
  return value;
}

export function obj(input: Input, field: string, options: { maxBytes: number }): Record<string, unknown> | undefined {
  const value = input[field];
  if (absent(value)) return undefined;
  ensure(typeof value === "object" && !Array.isArray(value), 400, "INVALID_REQUEST", `${field} must be an object.`);
  ensure(
    Buffer.byteLength(JSON.stringify(value)) <= options.maxBytes,
    413,
    "PAYLOAD_TOO_LARGE",
    `${field} may be at most ${options.maxBytes / 1024} KiB when serialised.`,
  );
  return value as Record<string, unknown>;
}
