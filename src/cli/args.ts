export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

/**
 * A deliberately small parser: `--flag`, `--flag value`, `--flag=value`, `-v`.
 * Everything after `--` is positional. No dependency, no surprises.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let passthrough = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (passthrough) {
      positional.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(body, next);
          index++;
        } else {
          flags.set(body, true);
        }
      }
    } else if (token.startsWith("-") && token.length > 1) {
      flags.set(token.slice(1), true);
    } else {
      positional.push(token);
    }
  }

  const [command = "", ...rest] = positional;
  return { command, positional: rest, flags };
}

export function flagString(
  args: ParsedArgs,
  name: string,
  fallback?: string,
): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : fallback;
}

export function flagNumber(
  args: ParsedArgs,
  name: string,
  fallback?: number,
): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`--${name} must be a number, got "${value}".`);
  return parsed;
}

export const flagBool = (args: ParsedArgs, name: string): boolean =>
  args.flags.get(name) === true || args.flags.get(name) === "true";
