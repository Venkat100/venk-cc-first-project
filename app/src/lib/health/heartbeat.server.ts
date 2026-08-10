// Cron heartbeat writer (PLAN.md §6 step 5, part A3) — server-only. See
// migration 0020's header for why a dedicated heartbeat table beats
// inferring freshness from business data. Wired into the two Vercel-Cron
// daily jobs (snapshot, agent-thinker) — the watchdog (GitHub Actions,
// intraday) is deliberately out of scope for this first cut; it's a much
// higher-frequency signal and a missed run is far less consequential than
// either daily job silently going stale.
//
// Never throws — a heartbeat write failing must never fail the cron run
// it's reporting on.

import { getServiceClient } from "@/lib/supabase/admin.server";

export async function recordHeartbeat(jobName: string, status: "ok" | "error", detail?: unknown): Promise<void> {
  try {
    const admin = getServiceClient();
    const { error } = await admin
      .from("cron_heartbeats")
      .upsert({ job_name: jobName, last_run_at: new Date().toISOString(), last_status: status, detail: detail ?? null }, { onConflict: "job_name" });
    if (error) console.error(`heartbeat("${jobName}") failed (non-fatal):`, error.message);
  } catch (e) {
    console.error(`heartbeat("${jobName}") threw (non-fatal):`, e instanceof Error ? e.message : e);
  }
}
