/** Every failure Portrail reports to a caller carries an HTTP status and a stable code. */
export class PortrailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PortrailError";
  }

  /** The wire shape. `retryable` tells a client whether trying again can help. */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.status === 503 || this.status === 429,
        ...(Object.keys(this.details).length ? { details: this.details } : {}),
      },
    };
  }
}

export function ensure(
  condition: unknown,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) throw new PortrailError(status, code, message, details);
}

/** Reads better than `ensure(false, ...)` at the end of a branch. */
export function fail(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new PortrailError(status, code, message, details);
}
