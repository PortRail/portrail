import type { SearchFilter } from "../types.ts";

/**
 * Expand `{a,b}` alternatives the way ripgrep does, nested ones included:
 * `*.{ts,tsx}` → `*.ts`, `*.tsx`. Returns null when the braces do not balance or an
 * alternation is empty — a pattern we cannot read is not one we can judge.
 */
export function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf("{");
  if (open < 0) return pattern.includes("}") ? null : [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length; index++) {
    if (pattern[index] === "{") depth++;
    else if (pattern[index] === "}") {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return null;
  const inside = pattern.slice(open + 1, close);
  if (!inside) return null;
  const alternatives: string[] = [];
  let level = 0;
  let current = "";
  for (const character of inside) {
    if (character === "{") level++;
    if (character === "}") level--;
    if (character === "," && level === 0) {
      alternatives.push(current);
      current = "";
    } else current += character;
  }
  alternatives.push(current);
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alternative of alternatives) {
    const expanded = expandBraces(prefix + alternative + suffix);
    if (!expanded) return null;
    out.push(...expanded);
  }
  return out;
}

export type { SearchFilter };
