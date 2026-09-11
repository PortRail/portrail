/**
 * Codex runs every command through a login shell: `/bin/zsh -lc 'cat file'`.
 * Claude Code sends `cat file`. A rule like `exec:cat *` must match both, so the
 * policy layer is shown the command a person would type, and the wrapper is kept
 * alongside as argv for anyone who needs the exact invocation.
 */
const SHELLS = /^(?:\/bin\/|\/usr\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)?(?:sh|bash|zsh|dash|fish)$/;

export interface UnwrappedCommand {
  /** What a person would type. */
  command: string;
  /** The literal invocation, when it was a wrapper. */
  argv?: string[];
}

export function unwrapShellCommand(raw: string): UnwrappedCommand {
  const tokens = shellSplit(raw);
  if (tokens.length === 3 && SHELLS.test(tokens[0]!) && /^-l?c$/.test(tokens[1]!))
    return { command: tokens[2]!, argv: tokens };
  return { command: raw };
}

/**
 * Minimal POSIX-style word splitting: whitespace-separated, with single quotes,
 * double quotes and backslash escapes. Enough to peel one wrapper layer; it is
 * not a shell parser and never runs anything.
 */
export function shellSplit(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && index + 1 < input.length && '"\\$`'.includes(input[index + 1]!))
        current += input[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "\\" && index + 1 < input.length) {
      current += input[++index];
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += char;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}
