// Tiny in-memory TTL cache (server-only) to respect the provider's free-tier
// rate limits — we don't re-fetch the same quote on every render.
//
// NOTE: in-memory is per-server-instance and resets on redeploy. That's fine
// for now. A durable Postgres `price_cache` table is a later optimization
// (see ARCHITECTURE.md) — intentionally NOT built in Phase 5.

type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Return a cached value for `key`, or run `fn`, cache its result for `ttlMs`,
 * and return it. Concurrent calls for the same key share one in-flight fetch.
 */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    try {
      const value = await fn();
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** Read a still-fresh value, or undefined. (For per-key batch caching.) */
export function cachePeek<T>(key: string): T | undefined {
  const e = store.get(key);
  if (e && e.expires > Date.now()) return e.value as T;
  return undefined;
}

/** Write a value with a TTL. */
export function cachePut(key: string, value: unknown, ttlMs: number): void {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

export const TTL = {
  quote: 30_000, // 30s — live-ish without hammering the API
  candles: 5 * 60_000, // 5min — historical bars barely move intraday
  search: 60 * 60_000, // 1h — symbol metadata is stable
} as const;
