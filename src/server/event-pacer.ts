/**
 * Returns true only when it wrote one event to the wire. What a sink skips is its own
 * business and costs nothing against the allowance.
 */
type Sink = () => boolean;
type Window = {
  sinks: Set<Sink>;
  sent: number[];
  cursor: number;
  pumping: boolean;
  timer?: NodeJS.Timeout;
};

/** One rolling delivery allowance per session, including reconnect/replay. */
export class SessionEventPacer {
  private windows = new Map<string, Window>();
  private disposed = false;
  constructor(private clock = () => performance.now()) {}

  subscribe(sessionId: string, sendOne: Sink) {
    if (this.disposed) throw new Error("Event pacer is closed");
    let window = this.windows.get(sessionId);
    if (!window) {
      window = { sinks: new Set(), sent: [], cursor: 0, pumping: false };
      this.windows.set(sessionId, window);
    }
    const current = window;
    current.sinks.add(sendOne);
    let active = true;
    return {
      wake: () => {
        if (active) this.pump(sessionId, current);
      },
      close: () => {
        if (!active) return;
        active = false;
        current.sinks.delete(sendOne);
        // Retain the window after the final disconnect so reconnecting cannot
        // reset an already consumed allowance. Its timer removes it on expiry.
        this.pump(sessionId, current);
      },
    };
  }

  private pump(sessionId: string, window: Window) {
    if (this.disposed || window.pumping) return;
    if (window.timer) clearTimeout(window.timer);
    window.timer = undefined;
    window.pumping = true;
    try {
      const time = this.clock();
      while (window.sent.length && (window.sent[0] ?? 0) <= time - 1000)
        window.sent.shift();
      while (window.sent.length < 100 && window.sinks.size) {
        const sinks = [...window.sinks];
        let delivered = false;
        for (let i = 0; i < sinks.length; i++) {
          const sink = sinks[window.cursor % sinks.length];
          window.cursor = (window.cursor + 1) % sinks.length;
          if (sink && window.sinks.has(sink) && sink()) {
            window.sent.push(this.clock());
            delivered = true;
            break;
          }
        }
        if (!delivered) break;
      }
    } finally {
      window.pumping = false;
      if (!window.sinks.size && !window.sent.length) {
        this.windows.delete(sessionId);
      } else if (!window.sinks.size || window.sent.length >= 100) {
        window.timer = setTimeout(
          () => this.pump(sessionId, window),
          Math.max(1, (window.sent[0] ?? 0) + 1000 - this.clock()),
        );
        window.timer.unref();
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const window of this.windows.values())
      if (window.timer) clearTimeout(window.timer);
    this.windows.clear();
  }
}
