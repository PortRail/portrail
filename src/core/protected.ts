import { closeSync, openSync, readSync } from "node:fs";

/**
 * Places no agent may ever touch, whatever workspace it is in: credential stores,
 * the logins of other tools, the agents' own configuration, shell rc files and
 * history, keychains, and Portrail's own data directory. Relative to home.
 *
 * `dir` says whether the entry is a directory (everything beneath it is protected)
 * or a single file — the sandbox globs need to know the difference.
 */
export const PROTECTED_HOME_ENTRIES: ReadonlyArray<{ path: string; dir: boolean }> = [
  // SSH, cloud and container credentials
  { path: ".ssh", dir: true },
  { path: ".aws", dir: true },
  { path: ".gnupg", dir: true },
  { path: ".kube", dir: true },
  { path: ".docker", dir: true },
  { path: ".azure", dir: true },
  { path: ".config/gcloud", dir: true },
  { path: ".terraform.d", dir: true },
  // Tool logins
  { path: ".config/gh", dir: true },
  { path: ".config/op", dir: true },
  { path: ".config/git", dir: true },
  { path: ".cargo/credentials", dir: false },
  { path: ".cargo/credentials.toml", dir: false },
  { path: ".netrc", dir: false },
  { path: ".npmrc", dir: false },
  { path: ".pypirc", dir: false },
  { path: ".gitconfig", dir: false },
  { path: ".git-credentials", dir: false },
  // The agents' own configuration and credentials
  { path: ".codex", dir: true },
  { path: ".claude", dir: true },
  { path: ".claude.json", dir: false },
  { path: ".config/claude", dir: true },
  { path: ".config/claude-code", dir: true },
  // Shell rc files and history — history routinely holds pasted tokens
  { path: ".zshrc", dir: false },
  { path: ".zprofile", dir: false },
  { path: ".zshenv", dir: false },
  { path: ".bashrc", dir: false },
  { path: ".bash_profile", dir: false },
  { path: ".profile", dir: false },
  { path: ".zsh_history", dir: false },
  { path: ".bash_history", dir: false },
  { path: ".zsh_sessions", dir: true },
  { path: ".node_repl_history", dir: false },
  { path: ".python_history", dir: false },
  // Keychains and this gateway's own data
  { path: "Library/Keychains", dir: true },
  { path: ".local/share/keyrings", dir: true },
  { path: ".portrail", dir: true },
];

/**
 * The same list as sandbox globs, matched anywhere in the tree, plus the secret
 * files that live inside a workspace rather than under home.
 */
export const SANDBOX_DENY_GLOBS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/*.pem",
  "**/id_rsa*",
  "**/id_ed25519*",
  ...PROTECTED_HOME_ENTRIES.map((entry) => `**/${entry.path}${entry.dir ? "/**" : ""}`),
];

/**
 * Files inside a workspace that hold the workspace's own credentials: a git remote
 * URL routinely carries a token, and git's credential store is plain text. They are
 * refused everywhere, for reading as well as writing, whatever the rules say.
 *
 * Deliberately not a `decide.deny` rule: the agents' OS sandboxes take those globs
 * verbatim, and git reads `.git/config` on every invocation, so a rule would stop
 * `git status` from running at all. What is protected is the file, not the command.
 */
export function isWorkspaceSecret(relativePath: string): boolean {
  const parts = relativePath
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const name = parts.at(-1);
  if (!name) return false;
  if (name === ".git-credentials") return true;
  const git = parts.lastIndexOf(".git");
  if (git === -1 || git === parts.length - 1) return false;
  const inside = parts.slice(git + 1, -1);
  const config = name === "config" || name === "config.worktree";
  if (inside.length === 0) return config || name === "credentials";
  // Submodules may have nested submodules or linked worktrees of their own.
  if (inside[0] === "modules" && inside.length >= 2) return config;
  return name === "config.worktree" && inside[0] === "worktrees" && inside.length === 2;
}

/**
 * How a credential sits in a git config: in the user part of a web URL, as a header git
 * sends with every request, or as a stored password. An ssh user is not a secret.
 */
const CREDENTIAL_FORMS: readonly RegExp[] = [
  // https://user:token@host and https://token@host, in a remote or a rewrite rule.
  /\b(?:https?|ftps?):\/\/[^\s/@"]+@/i,
  // http.extraheader = AUTHORIZATION: basic …, as CI checkouts persist it.
  /^\s*extraheader\s*=\s*\S/im,
  // A password stored in a credential section.
  /^\s*password\s*=/im,
];

/**
 * Whether a file a search would open really holds a credential.
 *
 * `.git/credentials` and `.git-credentials` exist for nothing else. `.git/config` is in
 * every repository and is usually dull, so it is read — a few kilobytes, once, only when
 * a search would open it — and refuses the search only when it carries a token in a
 * remote URL or a stored password. Refusing every repository's config would refuse
 * `rg --hidden x .` everywhere and buy nothing. Worktree configs get the same check.
 * A config larger than 64 KiB is protected without guessing about its unread suffix.
 */
export function holdsGitCredentials(
  absolutePath: string,
  relativePath: string,
): boolean {
  if (!isWorkspaceSecret(relativePath)) return false;
  const name = relativePath.split("/").at(-1)?.toLowerCase();
  if (name !== "config" && name !== "config.worktree") return true;
  let text: string;
  try {
    const handle = openSync(absolutePath, "r");
    try {
      const limit = 64 * 1024;
      // Read one extra byte to distinguish EOF from an unexamined suffix. Keep
      // reading after a short read; it does not establish the end of the file.
      const buffer = Buffer.alloc(limit + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = readSync(handle, buffer, bytes, buffer.length - bytes, bytes);
        if (read === 0) break;
        bytes += read;
      }
      if (bytes > limit) return true;
      text = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(handle);
    }
  } catch {
    // Unreadable is not a reason to let a search through.
    return true;
  }
  return CREDENTIAL_FORMS.some((form) => form.test(text));
}
