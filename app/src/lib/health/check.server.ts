// Health checks (PLAN.md §6 step 5, part A3) — the things that actually
// break for a stranger with nobody watching: the database, the market-data
// pipeline, and the two daily crons silently going stale. Pure(ish) so it
// can be exercised directly (verification, and in principle a future admin
// dashboard) without going through the HTTP layer at all.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";

const CRON_STALE_AFTER_MS = 26 * 60 * 60_000; // both daily crons run once/day; 26h = daily cadence + drift buffer, not a tight SLA
const CHECK_TIMEOUT_MS = 8_000;

function withTimeout<T>(label: string, p: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export type CheckResult = { ok: boolean; latencyMs?: number; error?: string };
export type CronCheckResult = { ok: boolean; lastRunAt?: string; lastStatus?: string; ageHours?: number; error?: string };

export type HealthReport = {
  ok: boolean;
  checkedAt: string;
  checks: {
    database: CheckResult;
    marketData: CheckResult;
    crons: Record<string, CronCheckResult>;
  };
};

async function checkDatabase(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const admin = getServiceClient();
    const { error } = await withTimeout("database check", Promise.resolve(admin.from("profiles").select("id").limit(1)));
    if (error) return { ok: false, latencyMs: Date.now() - t0, error: error.message };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : "database check failed" };
  }
}

async function checkMarketData(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    // Goes through the SAME durable L1+L2 cache path (cache.server.ts /
    // quote.server.ts) real requests use — this end-to-end checks the
    // pipeline (cache read/write + provider fallback on a miss), not just
    // "is Finnhub technically reachable" in isolation. Cost is bounded by
    // the exact same 30s TTL the rest of the app already shares (step 3's
    // arithmetic), so polling this endpoint doesn't add a meaningful new
    // cost even if hit far more often than the crons.
    const q = await withTimeout("market-data check", getServerQuote("AAPL"));
    if (!q || !(q.price > 0)) return { ok: false, latencyMs: Date.now() - t0, error: "No live price returned." };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : "market-data check failed" };
  }
}

async function checkCrons(): Promise<Record<string, CronCheckResult>> {
  const jobs = ["snapshot", "agent-thinker"] as const;
  const admin = getServiceClient();
  const { data, error } = await admin.from("cron_heartbeats").select("job_name, last_run_at, last_status");
  if (error) {
    const failure: CronCheckResult = { ok: false, error: error.message };
    return Object.fromEntries(jobs.map((j) => [j, failure]));
  }
  const byName = new Map((data ?? []).map((r) => [r.job_name as string, r]));
  const out: Record<string, CronCheckResult> = {};
  for (const job of jobs) {
    const row = byName.get(job);
    if (!row) {
      out[job] = { ok: false, error: "No heartbeat recorded yet." };
      continue;
    }
    const ageMs = Date.now() - new Date(row.last_run_at as string).getTime();
    const fresh = ageMs <= CRON_STALE_AFTER_MS;
    const succeeded = row.last_status === "ok";
    out[job] = {
      ok: fresh && succeeded,
      lastRunAt: row.last_run_at as string,
      lastStatus: row.last_status as string,
      ageHours: Math.round((ageMs / 3_600_000) * 10) / 10,
      ...(fresh ? {} : { error: "Stale — last run older than the expected daily cadence." }),
    };
  }
  return out;
}

export async function runHealthChecks(): Promise<HealthReport> {
  const [database, marketData, crons] = await Promise.all([checkDatabase(), checkMarketData(), checkCrons()]);
  const ok = database.ok && marketData.ok && Object.values(crons).every((c) => c.ok);
  return { ok, checkedAt: new Date().toISOString(), checks: { database, marketData, crons } };
}
