export const HELP = `Portrail — an HTTP API in front of the coding agent on this machine.

Usage: portrail <command> [options]

Setup
  init [--workspace <dir>] [--name n] [--key <name>]
                                            Data directory, config, and optionally a first workspace and key
  workspace add <path> [--name n] | list | remove <name>
  key create <name> [--scopes a,b] [--expires <days>] | list | revoke <id>
  doctor [--live]                           Will a run work? --live asks Claude for a real completion

Run
  start [--port] [--host] [--tunnel [kind]] [--insecure] [--with-fake-agent]
  status                                    Is the gateway running?
  run "<prompt>" [--agent codex|claude] [--workspace n] [--json]
                                            Needs a running gateway and PORTRAIL_KEY (or --key)
  approve [id] | deny [id]                  Answer an operation the rules put in decide.ask — once, from this machine
  logs [-f] [--limit n]                     Recent runs and decisions; -f follows live events
  service install [start flags] | uninstall | status

Options
  --home <dir>       Data directory (default ~/.portrail, or PORTRAIL_HOME)
  --json             Machine-readable output
  --version          Print the version
  --help             This message; portrail <command> --help for one command

Start here:
  portrail init --workspace . --key local
  portrail start
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `portrail init [--workspace <dir>] [--name <workspace-name>] [--key <key-name>]
Creates the data directory and config. With --workspace, enrols that folder (name defaults to the folder's name).
With --key, creates an API key and prints its token once.`,
  start: `portrail start [--port <n>] [--host <addr>] [--tunnel [cloudflare|ngrok|tailscale]] [--insecure] [--with-fake-agent] [--relay <url>]
Runs the gateway in the foreground. Binds 127.0.0.1:7431 unless configured.
--tunnel opens an outbound tunnel and prints the public URL. --insecure allows a non-loopback bind without TLS (prints a warning).
--with-fake-agent adds a scripted agent for tests. --relay connects this machine to a Portrail Pro relay (needs Pro installed here).`,
  status: `portrail status [--json]
Reports whether a gateway is running from this data directory and what /health says.`,
  doctor: `portrail doctor [--live] [--json]
Checks Node, data directory, config, both agents, workspaces, keys, the listener, tunnels and Pro.
Codex is always checked through its app-server (no inference). Claude is checked from credentials on disk; --live asks it for a real completion.
Exits 0 only if a run would work.`,
  key: `portrail key create <name> [--scopes runs:write,runs:read,...] [--expires <days>]
portrail key list [--json]
portrail key revoke <id>
Scopes: runs:write runs:read approvals:decide workspaces:admin policy:admin keys:admin, or * (default). The token is printed once.`,
  workspace: `portrail workspace add <path> [--name <name>]
portrail workspace list [--json]
portrail workspace remove <name>
A workspace is a folder the agent may work in. Home, root and Portrail's own data directory are refused.`,
  run: `portrail run [--json] "<prompt>" [--agent codex|claude] [--workspace <name>] [--key prt_...]
Sends one request to the running gateway and streams the result. Reads PORTRAIL_KEY if --key is absent.
When an operation matches decide.ask, run asks you "Allow this once? [y/N]" right here (or, without a
terminal, tells you to answer with portrail approve/deny). Nothing is remembered; no rule is written.
Exit codes: 0 done; 2 finished but your rules refused something; 1 did not finish.`,
  approve: `portrail approve [<operation-id>] [--json]
portrail deny [<operation-id>] [--json]
Answers an operation that is waiting because it matched decide.ask in config.json. With no id, answers the
one operation that is waiting (lists them if there are several). Once only: the next identical operation
asks again. Works only on this machine — the credential is the token in daemon.json, not an API key.
Portrail Pro adds answers from anywhere, by anyone, with scopes and a record: portrail approvals …`,
  get deny() {
    return this.approve!;
  },
  logs: `portrail logs [-f] [--limit <n>] [--json]
Recent runs with their decision counts. -f follows new events across all sessions.`,
  service: `portrail service install [start flags] | uninstall | status
Installs a launchd agent (macOS) or systemd user unit (Linux) that runs \`portrail start\` at login.`,
};
