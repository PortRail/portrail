/**
 * Failed authentications, counted per client address over a rolling minute. Ten in a
 * minute lock the address out for the rest of that minute: the daemon keeps serving
 * everyone else, and an attacker learns nothing faster than one guess per six seconds
 * on average. Every failure is logged with the address, the code and the route — never
 * the key material. Requests refused while locked are not counted, so hammering cannot
 * extend a lockout.
 */
export class AuthGuard {
  private readonly failures = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private lastSweep: number;

  constructor(
    options: {
      limit?: number;
      windowMs?: number;
      now?: () => number;
      log?: (line: string) => void;
    } = {},
  ) {
    this.limit = options.limit ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.error(line));
    this.lastSweep = this.now();
  }

  /** How many addresses are being watched right now. */
  get size(): number {
    return this.failures.size;
  }

  /** Seconds this address must wait before another attempt is looked at, or 0. */
  retryAfter(address: string): number {
    const recent = this.recent(address);
    if (recent.length < this.limit) return 0;
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - this.now()) / 1000));
  }

  /** Record one failed authentication. */
  failed(address: string, code: string, method: string, url: string): void {
    const recent = this.recent(address);
    const route = url.split("?")[0]!.slice(0, 200);
    if (recent.length >= this.limit) return; // already locked: refused before it was looked at
    recent.push(this.now());
    this.failures.set(address, recent);
    this.log(`auth failed from ${address}: ${code} ${method} ${route}`);
    if (recent.length === this.limit)
      this.log(
        `auth failed from ${address}: locked out for ${this.retryAfter(address)} s after ${this.limit} failures`,
      );
    this.sweep();
  }

  /** The failures of this address inside the window, oldest first. */
  private recent(address: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(address) ?? []).filter((at) => at > cutoff);
    if (kept.length) this.failures.set(address, kept);
    else this.failures.delete(address);
    return kept;
  }

  /** Forget addresses whose failures have all aged out; cheap, so it runs on every write once the table is large. */
  private sweep(): void {
    if (this.failures.size < 10_000 && this.now() - this.lastSweep < this.windowMs)
      return;
    this.lastSweep = this.now();
    const cutoff = this.now() - this.windowMs;
    for (const [address, times] of this.failures)
      if (!times.some((at) => at > cutoff)) this.failures.delete(address);
  }
}
