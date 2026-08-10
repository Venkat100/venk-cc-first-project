// Retention/prune job for rate_limit_events (PLAN.md §6 step 5, part A2).
// The longest window any check reads is the daily cap (24h), so a row is
// never read past ~24h of age anyway — mirrors pruneCache.server.ts's own
// reasoning exactly, just with a shorter retention since there's no
// debugging value in keeping abuse-guard events around for a week.

import { getServiceClient } from "@/lib/supabase/admin.server";

const RETENTION_MS = 2 * 24 * 60 * 60_000; // 2 days — headroom past the 24h daily window

export type RateLimitPruneSummary = { ranAt: string; cutoff: string; deleted: number };

export async function runRateLimitPrune(opts: { retentionMs?: number } = {}): Promise<RateLimitPruneSummary> {
  const admin = getServiceClient();
  const cutoff = new Date(Date.now() - (opts.retentionMs ?? RETENTION_MS)).toISOString();
  const { data, error } = await admin.from("rate_limit_events").delete().lt("created_at", cutoff).select("id");
  if (error) throw new Error("rate_limit_events prune failed: " + error.message);
  return { ranAt: new Date().toISOString(), cutoff, deleted: (data ?? []).length };
}
