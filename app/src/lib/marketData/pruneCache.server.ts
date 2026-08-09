// Retention/prune job for the durable price_cache table (PLAN.md §6 step 2).
// Without this, price_cache grows forever, exactly the gap the `insights`
// table has today (flagged, not yet fixed at the time this was written —
// see 0017's grant note). Every row here is disposable derived data (never
// the only copy of anything — a pruned row just means the next reader falls
// through to the provider again), so pruning is always safe.
//
// Threshold: 7 days. The longest TTL in use is 24h (profile/daily-history),
// so a fresh row is never even READ past ~24h of staleness anyway — 7 days
// is just headroom for inspection/debugging, not a freshness guarantee.

import { getServiceClient } from "@/lib/supabase/admin.server";

const RETENTION_MS = 7 * 24 * 60 * 60_000; // 7 days

export type PriceCachePruneSummary = { ranAt: string; cutoff: string; deleted: number };

export async function runPriceCachePrune(opts: { retentionMs?: number } = {}): Promise<PriceCachePruneSummary> {
  const admin = getServiceClient();
  const cutoff = new Date(Date.now() - (opts.retentionMs ?? RETENTION_MS)).toISOString();
  const { data, error } = await admin.from("price_cache").delete().lt("fetched_at", cutoff).select("kind");
  if (error) throw new Error("price_cache prune failed: " + error.message);
  return { ranAt: new Date().toISOString(), cutoff, deleted: (data ?? []).length };
}
