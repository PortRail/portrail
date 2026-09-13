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
