// Protects Railway's API quota from browser polling. Two mechanisms, both
// load-bearing (the naive versions are provably wrong):
//   1. TTL alone does not coalesce concurrent cold misses: N tabs arriving on
//      an empty cache would fire N upstream reads. All callers during a fetch
//      share the single in-flight promise.
//   2. A cached pre-mutation snapshot can visually regress the UI after a
//      mutation is acknowledged (click "up", then a stale IDLE arrives).
//      Mutation paths call invalidate() BEFORE acknowledging, so the next read
//      observes reality.

export interface StatusCacheDeps {
  /** Monotonic clock in ms. Injectable for tests. */
  clock: () => number;
}

export class StatusCache<T> {
  readonly #fetch: () => Promise<T>;
  readonly #ttlMs: number;
  readonly #clock: () => number;
  #cached: { value: T; at: number } | null = null;
  #inFlight: Promise<T> | null = null;

  constructor(fetch: () => Promise<T>, ttlMs: number, deps: StatusCacheDeps) {
    this.#fetch = fetch;
    this.#ttlMs = ttlMs;
    this.#clock = deps.clock;
  }

  async get(): Promise<T> {
    const cached = this.#cached;
    if (cached !== null && this.#clock() - cached.at < this.#ttlMs) {
      return cached.value;
    }
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    const flight = this.#fetch().then(
      (value) => {
        this.#cached = { value, at: this.#clock() };
        this.#inFlight = null;
        return value;
      },
      (e: unknown) => {
        // A failed fetch must not wedge the cache: clear the flight so the
        // next caller retries instead of awaiting a dead promise forever.
        this.#inFlight = null;
        throw e;
      },
    );
    this.#inFlight = flight;
    return flight;
  }

  /** Call before acknowledging any mutation. The next get() hits upstream. */
  invalidate(): void {
    this.#cached = null;
  }
}
