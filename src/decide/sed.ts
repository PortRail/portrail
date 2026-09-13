/**
 * `sed -n` is on the built-in allow list because Codex reads files with it
 * constantly — but sed is a programming language. `w` writes files, `r` reads
 * them, `e` runs commands, `-i` edits in place, `-f` loads a script. Only scripts
 * that print or filter are allowed; everything else is refused rather than guessed
 * at, because a rule cannot tell `w` the command from `w` in a pattern.
 */

/** Text between `/` delimiters, with backslash escapes. */
const PART = String.raw`(?:[^/\\]|\\.)*`;
const ADDRESS = String.raw`(?:\d+|\$|/${PART}/)`;
const RANGE = String.raw`(?:${ADDRESS}(?:,${ADDRESS})?)?`;
/** Print, delete, hold-space shuffles, `=`, `l`, `q`, and `s`/`y` with `/` delimiters and safe flags. */
const COMMAND = String.raw`(?:[pPdDnNhHgGx=]|[qQ]\d*|l\d*|s/${PART}/${PART}/[gpI0-9]*|y/${PART}/${PART}/)`;
const STATEMENT = String.raw`\s*${RANGE}\s*!?\s*${COMMAND}\s*`;
export const SED_PRINT_FILTER = new RegExp(String.raw`^${STATEMENT}(?:;${STATEMENT})*;?$`);

/** Options that change how sed reads, not what it may do. */
const FLAGS = /^-[nErsuz]+$/;
const LONG_FLAGS = new Set(["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data"]);

/**
 * Why a sed invocation does more than print or filter, or null when it is fine.
 * `words` is the command with wrappers removed: `words[0]` is sed itself.
 */
export function sedObjection(words: readonly string[]): string | null {
  const scripts: string[] = [];
  const files: string[] = [];
  let scriptFromFlag = false;
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") {
      files.push(...words.slice(index + 1));
      break;
    }
    if (LONG_FLAGS.has(word)) continue;
    if (word.startsWith("--expression=")) {
      scripts.push(word.slice("--expression=".length));
      scriptFromFlag = true;
      continue;
    }
    if (/^-[nErsuz]*e/.test(word)) {
      // `-e script`, `-ne script`, `-escript`
      const attached = word.slice(word.indexOf("e") + 1);
      scripts.push(attached || words[++index] || "");
      scriptFromFlag = true;
      continue;
    }
    if (FLAGS.test(word)) continue;
    if (word.startsWith("-") && word !== "-") return `option ${word}`;
    // Without -e, the first bare word is the script and the rest are files.
    (scriptFromFlag || scripts.length ? files : scripts).push(word);
  }
  if (!scripts.length) return "no script";
  const offending = scripts.find((script) => !SED_PRINT_FILTER.test(script));
  return offending === undefined ? null : `script ${JSON.stringify(offending)}`;
}
