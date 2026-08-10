// Retention/prune job for analytics_events (PLAN.md §6 step 5, part A3).
// legal/privacy.md §5 explicitly commits: "Error logs and analytics —
// retained for a limited period on a rolling basis and then discarded."
// This is the code that makes that true rather than aspirational.
//
// 90 days: a genuinely LIMITED window (not "forever, in practice") while
// still long enough for the actual product questions this data exists to
// answer (signup trend, activation rate, feature usage) to be evaluated
// month-over-month, not just week-over-week. Deletes unconditionally on
// age — this also ages out the ANONYMIZED (user_id IS NULL) rows a
// deleted account leaves behind (migration 0020's ON DELETE SET NULL), so
// "limited period... discarded" holds for those too, not just
// still-linked rows.
import { getServiceClient } from "@/lib/supabase/admin.server";

const RETENTION_MS = 90 * 24 * 60 * 60_000; // 90 days

export type AnalyticsPruneSummary = { ranAt: string; cutoff: string; deleted: number };

export async function runAnalyticsPrune(opts: { retentionMs?: number } = {}): Promise<AnalyticsPruneSummary> {
  const admin = getServiceClient();
  const cutoff = new Date(Date.now() - (opts.retentionMs ?? RETENTION_MS)).toISOString();
  const { data, error } = await admin.from("analytics_events").delete().lt("created_at", cutoff).select("id");
  if (error) throw new Error("analytics_events prune failed: " + error.message);
  return { ranAt: new Date().toISOString(), cutoff, deleted: (data ?? []).length };
}
