// Proactive cron-staleness alerting (2026-08-19 — HANDOFF.md). Closing the
// loop on the whole incident this session: /api/health already KNEW
// agent-thinker's heartbeat was stale, and it told us only because someone
// happened to run it manually. Nothing pushed that fact anywhere. This
// module is what makes staleness self-announcing instead of something you
// have to go looking for — piggybacked onto the snapshot cron (the one job
// on record with a 100% reliable daily heartbeat of its own), which calls
// checkStaleHeartbeats() right after writing its own heartbeat and reports
// any breach through captureServerError() — the SAME Sentry pipeline every
// real production error already uses, proven live the same day this file
// was written (HANDOFF.md's Sentry config-drift entry).
//
// Deliberately NOT a new cron job of its own: a dedicated "watch the other
// crons" cron would just be a fourth scheduler with the exact same
// "is IT still running" problem this whole file exists to solve. Riding on
// an already-reliable heartbeat sidesteps that regress entirely.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { captureServerError } from "@/lib/sentry/server";

export type JobStalenessSpec = {
  jobName: string;
  /** How stale (hours since last_run_at) before this job is flagged. */
  staleAfterHours: number;
  /** Why this number, so a future reader isn't left guessing. */
  reason: string;
};

/**
 * Vercel-Cron jobs (agent-thinker, snapshot) run at a fixed daily UTC
 * minute with reliable platform timing — 26h (daily cadence + a modest
 * drift buffer) matches check.server.ts's own existing CRON_STALE_AFTER_MS,
 * kept in sync deliberately rather than duplicated with a different number.
 *
 * GitHub-Actions-scheduled jobs need MORE slack, for two real reasons
 * documented in .github/workflows/*.yml: scheduled runs can be delayed
 * under GitHub's own platform load (not guaranteed timing, per GitHub's
 * docs), and a workflow auto-disables after 60 days of zero repository
 * activity — both failure modes look identical from here (the heartbeat
 * just stops advancing), so one generous-enough threshold catches both
 * without a separate mitigation for each.
 *   - agent-watchdog: intraday, market-hours only (agent-watchdog.yml's own
 *     schedule: every 30 minutes, 13:00-21:59 UTC, Monday-Friday), so a
 *     heartbeat LEGITIMATELY goes quiet over a weekend (Friday close to
 *     Monday open). 96h (4 days) covers a 3-day holiday weekend plus a
 *     buffer without a false alarm, while still catching a genuine
 *     multi-day silent failure.
 *   - daily-brief: once daily, no market-hours gating. 48h absorbs one
 *     delayed or missed run before alerting, catching a genuine 2-day gap
 *     — the exact shape of the incident this file exists to prevent from
 *     recurring silently a second time.
 */
export const JOB_STALENESS_SPECS: JobStalenessSpec[] = [
  { jobName: "agent-thinker", staleAfterHours: 26, reason: "daily Vercel Cron, fixed UTC time" },
  { jobName: "snapshot", staleAfterHours: 26, reason: "daily Vercel Cron, fixed UTC time (this job's own heartbeat — included for completeness, though a genuinely stale snapshot heartbeat can't reach this check, since this check only runs when snapshot itself just succeeded)" },
  { jobName: "agent-watchdog", staleAfterHours: 96, reason: "GitHub Actions, market-hours only — must absorb a 3-day weekend without alarming" },
  { jobName: "daily-brief", staleAfterHours: 48, reason: "GitHub Actions, daily — absorbs one delayed/missed run before alerting" },
];

export type StaleJob = { jobName: string; lastRunAt: string | null; ageHours: number | null; staleAfterHours: number };

/** Pure — given real heartbeat rows, returns which tracked jobs are stale
 *  (or never seen at all). No I/O, cheaply testable separately from the
 *  DB read and the Sentry call below. */
export function findStaleJobs(heartbeats: { job_name: string; last_run_at: string }[], now: Date = new Date()): StaleJob[] {
  const byName = new Map(heartbeats.map((h) => [h.job_name, h.last_run_at]));
  const stale: StaleJob[] = [];
  for (const spec of JOB_STALENESS_SPECS) {
    const lastRunAt = byName.get(spec.jobName) ?? null;
    const ageHours = lastRunAt ? (now.getTime() - new Date(lastRunAt).getTime()) / 3_600_000 : null;
    if (ageHours === null || ageHours >= spec.staleAfterHours) {
      stale.push({ jobName: spec.jobName, lastRunAt, ageHours, staleAfterHours: spec.staleAfterHours });
    }
  }
  return stale;
}

/** Reads real heartbeats, finds stale jobs, and reports each one through
 *  Sentry — never throws (a staleness-alerting bug must never fail the
 *  snapshot cron it rides on), matching heartbeat.server.ts's own
 *  never-throws contract. */
export async function checkStaleHeartbeats(): Promise<StaleJob[]> {
  try {
    const admin = getServiceClient();
    const { data, error } = await admin.from("cron_heartbeats").select("job_name, last_run_at");
    if (error) {
      console.error("checkStaleHeartbeats: read failed (non-fatal):", error.message);
      return [];
    }
    const stale = findStaleJobs(data ?? []);
    for (const job of stale) {
      captureServerError(new Error(`[staleness] cron "${job.jobName}" is stale`), {
        jobName: job.jobName,
        lastRunAt: job.lastRunAt,
        ageHours: job.ageHours !== null ? Math.round(job.ageHours * 10) / 10 : null,
        staleAfterHours: job.staleAfterHours,
      });
    }
    return stale;
  } catch (e) {
    console.error("checkStaleHeartbeats threw (non-fatal):", e instanceof Error ? e.message : e);
    return [];
  }
}
