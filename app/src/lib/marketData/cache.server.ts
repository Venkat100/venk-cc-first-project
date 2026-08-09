// Tiny in-memory TTL cache (server-only) to respect the provider's free-tier
// rate limits — we don't re-fetch the same quote on every render.
//
// `cached`/`cachePeek`/`cachePut`/`TTL` below are L1-ONLY (in-process memory)
// and UNCHANGED from Phase 5 — still used as-is by the options chain cache
// and AI Insights' hot fast-path (both already have their own durability:
// options recompute cheaply from now-durable daily history, insights persist
// to the `insights` table directly). Touching those wasn't asked for and
// isn't needed for the capacity problem this file exists to solve.
//
// `durableCached`/`durablePeekMany`/`durablePutMany` below are the NEW L1+L2
// tier (PLAN.md §6 step 2, pulled forward from Phase D): L1 = this same
// in-memory Map (fast, but dies every serverless invocation) sitting on top
// of L2 = the `price_cache` Postgres table (durable, shared by every
// invocation and every user). Used ONLY by the actual market-data provider
// call sites (quotes, candles, search, profile/metric/name/news enrichment,
// the 5Y daily-history helper) — the raw, provider-sourced payloads this
// capacity problem is actually about. Read path: L1 → L2 → provider, then
// populate both. Write-through only on a genuine provider success — an
// error from `fn()` propagates without writing either tier, so a bad
// response can never "poison" the cache (verified in verify-price-cache.ts).
//
// CACHE STAMPEDE (documented per the build spec, not left unconsidered):
// same-process concurrent requests for one key already dedupe via the
// `inflight` map below (unchanged since Phase 5) — two callers in the SAME
// invocation always share one fetch. Across DIFFERENT cold invocations
// (empty L1, e.g. two Vercel functions spun up back-to-back) there's a real
// but BOUNDED race: both can miss L1 and L2 before either's provider fetch
// completes and its L2 write lands, so both call the provider once. We
// accept this rather than build a Postgres advisory lock / "claim" row,
// because: (1) the race window is only as wide as one provider round-trip
// (typically 100–500ms), not sustained; (2) worst case is a HANDFUL of
// duplicate calls, not O(users) — the whole point of this table is that
// after the first successful write, every subsequent cold invocation
// (however many) reads L2 instead of the provider; (3) at today's real
// concurrent-user count this is a non-issue in practice; (4) a proper lock
// adds real complexity (timeout/stale-lock/retry handling) for a marginal
// win at this scale. Escalation path if usage ever shows sustained
// stampede (not just this bounded race): a short `pg_advisory_xact_lock`
// keyed on (kind,symbol,interval) around the L2-miss→provider-fetch→L2-write
// sequence, or an "in-flight" marker row with a claim-and-wait poll.

import { getServiceClient } from "@/lib/supabase/admin.server";

type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** TEST-ONLY seam: empties L1 to simulate a fresh/cold serverless invocation
 *  within one process, for verify-price-cache.ts's stampede test — the task
 *  spec explicitly treats "an explicitly cleared L1" as equivalent to a real
 *  separate process for this purpose (L2/Postgres is the only tier that
 *  actually needs to persist across a real cold start; an empty L1 Map is
 *  the whole observable difference). Never called from product code. */
export function __clearL1ForTest(): void {
  store.clear();
  inflight.clear();
}

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

// ── L2 (durable, Postgres price_cache) — internal helpers ────────────────
// Every L2 call is best-effort: a read failure is treated as a miss (falls
// through to the provider, exactly as if the row didn't exist) and a write
// failure is swallowed (logged, never thrown) — a cache-layer outage must
// degrade to "slower" (more provider calls), never to a broken request.

async function l2GetMany(kind: string, symbols: string[], interval: string, ttlMs: number): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (symbols.length === 0) return out;
  try {
    const admin = getServiceClient();
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const { data, error } = await admin
      .from("price_cache")
      .select("symbol, payload, fetched_at")
      .eq("kind", kind)
      .eq("interval", interval)
      .in("symbol", symbols)
      .gte("fetched_at", cutoff);
    if (error) {
      console.error(`[price_cache] L2 read failed (kind=${kind}, interval=${interval}):`, error.message);
      return out;
    }
    for (const row of data ?? []) out.set(row.symbol as string, row.payload);
  } catch (e) {
    console.error(`[price_cache] L2 read threw (kind=${kind}, interval=${interval}):`, e instanceof Error ? e.message : e);
  }
  return out;
}

async function l2PutMany(kind: string, interval: string, rows: Array<{ symbol: string; payload: unknown }>): Promise<void> {
  if (rows.length === 0) return;
  try {
    const admin = getServiceClient();
    const now = new Date().toISOString();
    const { error } = await admin
      .from("price_cache")
      .upsert(
        rows.map((r) => ({ kind, symbol: r.symbol, interval, payload: r.payload as never, fetched_at: now })),
        { onConflict: "kind,symbol,interval" },
      );
    if (error) console.error(`[price_cache] L2 write failed (kind=${kind}, interval=${interval}):`, error.message);
  } catch (e) {
    console.error(`[price_cache] L2 write threw (kind=${kind}, interval=${interval}):`, e instanceof Error ? e.message : e);
  }
}

/** L1-key convention for the durable helpers below — shared across every
 *  call site so the SAME symbol/kind always lands on the SAME L1 entry
 *  (preserves the existing "one cached quote serves every screen" sharing
 *  that plain quote:${sym} keys had, just derived consistently instead of
 *  hand-written per call site). */
function durableKey(kind: string, symbol: string, interval: string): string {
  return interval ? `${kind}:${symbol}:${interval}` : `${kind}:${symbol}`;
}

/** Durable (L1 in-memory + L2 Postgres) read-through cache for ONE key.
 *  Same in-flight/TTL semantics as `cached()` above, with an L2 check
 *  inserted on an L1 miss (before calling `fn`) and an L2 write alongside
 *  the L1 write on a genuine provider fetch. `fn` throwing propagates
 *  without writing either tier. */
export async function durableCached<T>(kind: string, symbol: string, interval: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const l1Key = durableKey(kind, symbol, interval);
  const now = Date.now();
  const hit = store.get(l1Key);
  if (hit && hit.expires > now) return hit.value as T;

  const pending = inflight.get(l1Key);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    try {
      const l2Hit = await l2GetMany(kind, [symbol], interval, ttlMs);
      if (l2Hit.has(symbol)) {
        const value = l2Hit.get(symbol) as T;
        store.set(l1Key, { value, expires: Date.now() + ttlMs });
        return value;
      }
      const value = await fn();
      store.set(l1Key, { value, expires: Date.now() + ttlMs });
      await l2PutMany(kind, interval, [{ symbol, payload: value }]);
      return value;
    } finally {
      inflight.delete(l1Key);
    }
  })();

  inflight.set(l1Key, p);
  return p;
}

/** Batch peek across L1 then L2 for MANY symbols at once (one L2 round trip
 *  for whatever missed L1, not one per symbol) — the shape a fan-out like
 *  "quotes for every holding on this dashboard" needs: find out what's
 *  already fresh, so the caller only asks the provider for the remainder.
 *  L2 hits are written back into L1 so a second call in the same
 *  invocation is a pure L1 hit. */
export async function durablePeekMany<T>(kind: string, symbols: string[], interval: string, ttlMs: number): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  const now = Date.now();
  const stillMissing: string[] = [];
  for (const sym of symbols) {
    const hit = store.get(durableKey(kind, sym, interval));
    if (hit && hit.expires > now) result.set(sym, hit.value as T);
    else stillMissing.push(sym);
  }
  if (stillMissing.length > 0) {
    const l2Hits = await l2GetMany(kind, stillMissing, interval, ttlMs);
    for (const [sym, value] of l2Hits) {
      result.set(sym, value as T);
      store.set(durableKey(kind, sym, interval), { value, expires: now + ttlMs });
    }
  }
  return result;
}

/** Batch write-through: populate both L1 and L2 for many symbols in ONE L2
 *  upsert, not N individual writes. Pair with `durablePeekMany` for a
 *  provider call that fetches many symbols in one request. */
export async function durablePutMany<T>(kind: string, interval: string, entries: Array<{ symbol: string; value: T }>, ttlMs: number): Promise<void> {
  const now = Date.now();
  for (const e of entries) store.set(durableKey(kind, e.symbol, interval), { value: e.value, expires: now + ttlMs });
  await l2PutMany(kind, interval, entries.map((e) => ({ symbol: e.symbol, payload: e.value })));
}
