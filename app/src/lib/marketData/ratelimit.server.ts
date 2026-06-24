// Server-only rate limiting + retry/backoff + timeout helpers for the market
// providers (Finnhub free tier = 60 req/min). Keeps unattended batch jobs
// (snapshots, agent thinker/watchdog) safely under the cap and resilient to
// transient 429/5xx/network blips, without ever hanging on a stuck call.
//
// Clock-injectable so the limiter and backoff are deterministically testable.

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Sliding-window limiter with a concurrency cap. Allows bursts up to
 * `maxPerWindow` requests per `windowMs`, then spaces further requests so we
 * stay under the provider cap. `maxConcurrency` bounds in-flight requests so a
 * batch can't fire hundreds of parallel fetches.
 */
export class RateLimiter {
  private active = 0;
  private recent: number[] = []; // start timestamps within the window
  constructor(
    private readonly maxPerWindow: number,
    private readonly maxConcurrency: number,
    private readonly clock: Clock = realClock,
    private readonly windowMs = 60_000,
  ) {}

  private hasWindowRoom(now: number): boolean {
    while (this.recent.length && now - this.recent[0] >= this.windowMs) this.recent.shift();
    return this.recent.length < this.maxPerWindow;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      if (this.active < this.maxConcurrency && this.hasWindowRoom(now)) {
        this.active++;
        this.recent.push(now);
        return;
      }
      // If the window is full, wait until the oldest request ages out; otherwise
      // it's a concurrency wait, so poll briefly.
      const windowFull = this.recent.length >= this.maxPerWindow;
      const wait = windowFull ? this.windowMs - (now - this.recent[0]) + 5 : 20;
      await this.clock.sleep(Math.max(5, wait));
    }
  }

  release(): void {
    if (this.active > 0) this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Requests currently counted in the live window (for tests/telemetry). */
  get windowCount(): number {
    this.hasWindowRoom(this.clock.now());
    return this.recent.length;
  }
}

export type RetryOpts = {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  isRetriable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, e: unknown) => void;
  random?: () => number;
};

/** Run `fn`, retrying retriable failures with exponential backoff + jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 4_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isRetriable = opts.isRetriable ?? (() => true);
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isRetriable(e)) break;
      opts.onRetry?.(attempt, e);
      const backoff = Math.min(maxMs, base * 2 ** attempt);
      await sleep(backoff + backoff * 0.25 * random());
    }
  }
  throw lastErr;
}

/** Run `fn(signal)` with a hard timeout that aborts it (so a call can't hang). */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}
