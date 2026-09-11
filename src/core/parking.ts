import type { Decision } from "../types.ts";

interface Parked {
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Where an operation waits while someone decides.
 *
 * The core owns this because a provider callback has to block *somewhere*: the
 * built-in decider parks what `decide.ask` matches, and an extension that answers
 * from elsewhere needs the same place to put the answer. Every parked operation has a
 * deadline, and a deadline resolves to deny, never allow.
 */
export class ParkingLot {
  private parked = new Map<string, Parked>();

  park(operationId: string, timeoutMs: number, onTimeout: () => Decision): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.parked.delete(operationId);
        resolve(onTimeout());
      }, timeoutMs);
      timer.unref();
      this.parked.set(operationId, { resolve, timer });
    });
  }

  /** Hand a decision to a waiting operation. Returns false if nothing was waiting. */
  resolve(operationId: string, decision: Decision): boolean {
    const entry = this.parked.get(operationId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.parked.delete(operationId);
    entry.resolve(decision);
    return true;
  }

  has(operationId: string): boolean {
    return this.parked.has(operationId);
  }

  /** Refuse everything still waiting — used on shutdown and when a run stops. */
  drain(reason: string, filter?: (operationId: string) => boolean) {
    for (const [operationId, entry] of this.parked) {
      if (filter && !filter(operationId)) continue;
      clearTimeout(entry.timer);
      this.parked.delete(operationId);
      entry.resolve({ verdict: "deny", reason });
    }
  }

  get size() {
    return this.parked.size;
  }
}
