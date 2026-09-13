import { resolve } from "node:path";
import type { Operation } from "../../types.ts";

/**
 * Claude Code's built-in tools, mapped to the one operation shape the policy layer
 * understands. Anything not listed here is refused: a tool we cannot classify is a
 * tool we cannot govern.
 */
export interface OperationBase {
  id: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  agent: "claude";
  requestedAt: string;
}

export function toolToOperation(
  name: string,
  input: Record<string, unknown>,
  base: OperationBase,
  workspaceRoot: string,
): Operation | null {
  const str = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  switch (name) {
    case "Bash":
      return {
        ...base,
        kind: "exec",
        command: str("command") ?? "",
        cwd: workspaceRoot,
        ...(str("description") ? { reason: str("description")! } : {}),
      };
    case "Write":
      return {
        ...base,
        kind: "write",
        changes: [{ path: str("file_path") ?? "", change: "update" }],
      };
    case "Edit":
    case "MultiEdit":
      return {
        ...base,
        kind: "write",
        changes: [
          {
            path: str("file_path") ?? "",
            change: "update",
            ...(str("old_string") !== undefined && str("new_string") !== undefined
              ? {
                  diff: `--- ${str("file_path")}\n+++ ${str("file_path")}\n-${str("old_string")}\n+${str("new_string")}`,
                }
              : {}),
          },
        ],
      };
    case "NotebookEdit":
      return {
        ...base,
        kind: "write",
        changes: [{ path: str("notebook_path") ?? "", change: "update" }],
      };
    case "Read":
      return { ...base, kind: "read", paths: [str("file_path") ?? ""] };
    case "Grep":
      // Content search: whatever lies under the directory can come back in the output.
      return {
        ...base,
        kind: "read",
        recursive: true,
        paths: [str("path") ?? workspaceRoot],
      };
    case "Glob": {
      // Names only — but a pattern that starts elsewhere or climbs out is judged as that place.
      const from = str("path") ?? workspaceRoot;
      const pattern = str("pattern") ?? "";
      const paths = [from];
      if (pattern.startsWith("/") || pattern.split("/").includes(".."))
        paths.push(resolve(from, pattern.split(/[*?[{]/)[0] ?? ""));
      return { ...base, kind: "read", paths };
    }
    case "WebFetch":
      return {
        ...base,
        kind: "net",
        ...(str("url") ? { url: str("url")!, host: safeHost(str("url")!) } : {}),
      };
    case "WebSearch":
      return { ...base, kind: "net", host: "web-search" };
    case "TodoWrite":
    case "TodoRead":
      // Bookkeeping inside the agent's own head. Nothing leaves the process.
      return { ...base, kind: "read", paths: [] };
    default:
      if (name.startsWith("mcp__")) {
        const [, server = "", ...rest] = name.split("__");
        return { ...base, kind: "tool", server, tool: rest.join("__"), input };
      }
      return null;
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The tools a governed run offers the model. Subagents and tasks are deliberately absent. */
export const GOVERNED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];
