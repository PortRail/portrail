/**
 * Two glob dialects, because paths and commands are not the same thing.
 *
 * Path mode: `*` stops at a slash, `**` crosses them, and `**​/x` also matches a
 * bare `x` at the root. Command mode: `*` matches anything, because a command line
 * has no meaningful segments and `git commit *` should match the whole tail. In both,
 * a backslash makes the character after it literal, so `report\?.txt` names one file.
 */
export function globToRegExp(
  pattern: string,
  pathMode: boolean,
  options: { ignoreCase?: boolean } = {},
): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "\\" && index + 1 < pattern.length) {
      index++;
      source += pattern[index]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (character === "*") {
      const doubled = pattern[index + 1] === "*";
      if (doubled) {
        index++;
        if (pathMode && pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += pathMode ? "[^/]*" : ".*";
      }
    } else if (character === "?") {
      source += pathMode ? "[^/]" : ".";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // Case-insensitive for every rule kind: APFS and NTFS are, so ".ENV" is ".env" — and a
  // command that names it is the same command however it is capitalised. A tool's own
  // glob (rg -g) is case-sensitive and asks for that explicitly.
  return new RegExp(source + "$", options.ignoreCase === false ? "" : "i");
}

export interface Pattern {
  kind: string;
  pattern: string;
  test(value: string): boolean;
  readonly source: string;
}

/** Parse one `kind:pattern` entry from the allow/deny lists. */
export function parsePattern(entry: string): Pattern {
  const separator = entry.indexOf(":");
  if (separator < 1)
    throw new Error(
      `Rule "${entry}" must look like "kind:pattern", for example "exec:npm test*".`,
    );
  const kind = entry.slice(0, separator);
  const pattern = entry.slice(separator + 1);
  if (!["read", "write", "exec", "net", "tool"].includes(kind))
    throw new Error(
      `Rule "${entry}" uses unknown kind "${kind}". Use read, write, exec, net or tool.`,
    );
  const pathMode = kind === "read" || kind === "write";
  const expression = globToRegExp(pattern, pathMode);
  return {
    kind,
    pattern,
    source: entry,
    test: (value: string) => expression.test(value),
  };
}

export function parsePatterns(entries: readonly string[]): Pattern[] {
  return entries.map(parsePattern);
}
