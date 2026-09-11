import type { CommandAction, Decision, FileChange } from "../../types.ts";

/** Codex's four decision words, plus the two amendment shapes we never send. */
export type CodexDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/**
 * Translate a Portrail decision into Codex's vocabulary.
 *
 * Always `accept`, never `acceptForSession`: the latter tells Codex to stop asking
 * for that command, which would take the gateway — and its audit log — out of the
 * loop for the rest of the thread. A "session" scope is remembered by the decider
 * instead, so every operation is still decided and recorded.
 *
 * `cancel` stops the whole turn, so it is reserved for a decision that explicitly
 * asks for it. An ordinary refusal is `decline`, which lets the agent explain
 * itself, try a different approach, or finish without the operation.
 */
export function toCodexDecision(decision: Decision): CodexDecision {
  return decision.verdict === "allow" ? "accept" : "decline";
}

/** Codex's `FileUpdateChange.kind` is a tagged union; flatten it for our shape. */
export function toFileChange(raw: any): FileChange {
  const kind = raw?.kind?.type ?? raw?.kind ?? "update";
  const change: FileChange["change"] =
    kind === "add" ? "add" : kind === "delete" ? "delete" : "update";
  return {
    path: String(raw?.path ?? ""),
    ...(typeof raw?.diff === "string" ? { diff: raw.diff } : {}),
    change,
  };
}

/** Codex classifies commands best-effort; keep it, it makes rules smarter. */
export function toCommandActions(raw: unknown): CommandAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((entry: any): CommandAction => {
      switch (entry?.type) {
        case "read":
          return { action: "read", path: entry.path };
        case "listFiles":
          return { action: "list", path: entry.path };
        case "search":
          return { action: "search", path: entry.path, query: entry.query };
        default:
          return { action: "unknown" };
      }
    });
}
