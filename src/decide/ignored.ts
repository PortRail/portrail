import { spawn } from "node:child_process";

/**
 * Which of `files` git ignores inside the repository at `root` — the files a
 * search that honours `.gitignore` never opens. Anything short of a clear answer
 * from git (no git, not a repository, an error) ignores nothing: the search is
 * then judged as if it read everything, which only ever refuses.
 */
export function gitIgnored(
  root: string,
  files: readonly string[],
): Promise<Set<string>> {
  if (!files.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const none = () => resolve(new Set());
    let child;
    try {
      child = spawn("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return none();
    }
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", none);
    child.on("close", (code) => {
      // 0: some are ignored, 1: none are; anything else is not an answer.
      if (code !== 0 && code !== 1) return none();
      const ignored = Buffer.concat(chunks)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      resolve(new Set(ignored));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(files.join("\0") + "\0");
  });
}
