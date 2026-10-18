/**
 * A limit of events per key and window, kept in the memory of the process (one API process
 * per server, ADR-26). For limits whose loss at a restart costs nothing: failed look-ups of
 * secure links, reports of the content security policy, requests for a password reset.
 * The brake of sign-in keeps its failures in the database instead (brake.service.ts).
 *
 * The number of keys is bounded: when it is full, the windows that have ended are dropped,
 * and then the oldest ones, so that a flood of new keys cannot fill the memory.
 */
export class RateLimiter {
  readonly #windows = new Map<string, { started: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Counts one event of `key`, or `amount` units of it (bytes). True while the key is within
   * its limit, this event included.
   */
  take(key: string, amount = 1): boolean {
    const now = this.now();
    let window = this.#windows.get(key);
    if (window === undefined || now - window.started >= this.windowMs) {
      this.#makeRoom(now);
      window = { started: now, count: 0 };
      this.#windows.delete(key);
      this.#windows.set(key, window);
    }
    window.count += amount;
    return window.count <= this.limit;
  }

  /** What the key has used of its limit in the current window. Counts nothing. */
  used(key: string): number {
    const window = this.#windows.get(key);
    return window !== undefined && this.now() - window.started < this.windowMs ? window.count : 0;
  }

  /** True when the key has used up its limit in the current window. Counts nothing. */
  isOver(key: string): boolean {
    const window = this.#windows.get(key);
    return (
      window !== undefined &&
      this.now() - window.started < this.windowMs &&
      window.count >= this.limit
    );
  }

  #makeRoom(now: number): void {
    if (this.#windows.size < this.maxKeys) {
      return;
    }
    for (const [key, window] of this.#windows) {
      if (now - window.started >= this.windowMs) {
        this.#windows.delete(key);
      }
    }
    for (const key of this.#windows.keys()) {
      if (this.#windows.size < this.maxKeys) {
        break;
      }
      this.#windows.delete(key);
    }
  }
}
