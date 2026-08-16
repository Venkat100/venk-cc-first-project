// Token-protected HTTP handler for the snapshot writer. Wired into the server
// entry at /api/cron/snapshot. Vercel Cron calls it daily in Phase 9; for now
// it's triggered manually for testing.
//
// Auth: requires the CRON_SECRET, supplied as `Authorization: Bearer <secret>`,
// `x-cron-secret: <secret>`, or `?secret=<secret>`. Missing/wrong → 401.
//
// This is the one daily "money maintenance" cron — Vercel Hobby caps us at 2
// crons and both slots are already used (this one + agent-thinker), so every
// daily batch job folds in HERE rather than getting its own, exactly like
// the AI daily-brief job folds into the agent-thinker cron. ORDER MATTERS,
// each step feeding the next:
//   1. O4 option expiration (cash settlement) — positions_value must reflect
//      today's settlements before anything below prices it.
//   2. M1 margin interest accrual — the day's interest is added to the loan
//      before the monitor checks equity, so a fresh call driven purely by
//      interest (not price movement) is still caught the same day.
//   3. M1 margin monitor (status transitions + simulated forced liquidation
//      on an actual call) — must run before the snapshot write so any
//      liquidation's cash/position changes land in the SAME day's snapshot.
//   4. Portfolio snapshot write.
//   5. price_cache prune (housekeeping, unrelated to the money steps above —
//      appended last deliberately; order relative to 1-4 doesn't matter).
//   6. rate_limit_events prune (A2 housekeeping, same reasoning as 5).
//   7. analytics_events prune (A3 housekeeping — makes legal/privacy.md's
//      "retained for a limited period... then discarded" promise actually
//      true, not aspirational; same reasoning as 5/6).
//   8. cron_heartbeats upsert (A3) — LAST, deliberately: it must reflect
//      whether THIS run succeeded or failed, so it has to run after
//      snapshotResult is known either way (see the ok/error branches below).
// Each step is isolated in its own try/catch — a failure in any one must
// never block the ones after it (most importantly, snapshots always run).

import { serverEnv } from "@/lib/marketData/env.server";
import { runExpiryProcessing } from "@/lib/options/expiry.server";
import { runInterestAccrual } from "@/lib/margin/interest.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { runPriceCachePrune } from "@/lib/marketData/pruneCache.server";
import { runRateLimitPrune } from "@/lib/rateLimit/prune.server";
import { runAnalyticsPrune } from "@/lib/analytics/prune.server";
import { runSnapshots } from "./writer.server";
import { recordHeartbeat } from "@/lib/health/heartbeat.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleSnapshotRequest(request: Request): Promise<Response> {
  const expected = serverEnv("CRON_SECRET");
  if (!expected) return json({ ok: false, error: "CRON_SECRET is not configured on the server." }, 500);

  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret") || url.searchParams.get("secret") || "";

  if (provided !== expected) return json({ ok: false, error: "Unauthorized." }, 401);

  let expiry;
  try {
    expiry = await runExpiryProcessing();
  } catch (e) {
    expiry = { error: e instanceof Error ? e.message : "Expiry processing failed." };
  }

  let interest;
  try {
    interest = await runInterestAccrual();
  } catch (e) {
    interest = { error: e instanceof Error ? e.message : "Interest accrual failed." };
  }

  let margin;
  try {
    margin = await runMarginMonitor();
  } catch (e) {
    margin = { error: e instanceof Error ? e.message : "Margin monitor failed." };
  }

  let snapshotResult: { ok: true; summary: unknown } | { ok: false; error: string };
  try {
    snapshotResult = { ok: true, summary: await runSnapshots() };
  } catch (e) {
    snapshotResult = { ok: false, error: e instanceof Error ? e.message : "Snapshot run failed." };
  }

  let priceCachePrune;
  try {
    priceCachePrune = await runPriceCachePrune();
  } catch (e) {
    priceCachePrune = { error: e instanceof Error ? e.message : "price_cache prune failed." };
  }

  let rateLimitPrune;
  try {
    rateLimitPrune = await runRateLimitPrune();
  } catch (e) {
    rateLimitPrune = { error: e instanceof Error ? e.message : "rate_limit_events prune failed." };
  }

  let analyticsPrune;
  try {
    analyticsPrune = await runAnalyticsPrune();
  } catch (e) {
    analyticsPrune = { error: e instanceof Error ? e.message : "analytics_events prune failed." };
  }

  // AWAITED, not fire-and-forget (2026-08-16, same fix as agent-thinker's
  // endpoint — see AGENT-AUDIT.md Part 1): this endpoint's own heartbeat
  // happened to land fresh in the audit's sample, but an un-awaited write
  // right before `return` is a race against the same serverless-teardown
  // risk regardless of which invocation currently gets lucky.
  if (snapshotResult.ok) {
    await recordHeartbeat("snapshot", "ok", { summary: snapshotResult.summary });
    return json({ ok: true, summary: snapshotResult.summary, expiry, interest, margin, priceCachePrune, rateLimitPrune, analyticsPrune }, 200);
  }
  await recordHeartbeat("snapshot", "error", { error: snapshotResult.error });
  return json({ ok: false, error: snapshotResult.error, expiry, interest, margin, priceCachePrune, rateLimitPrune, analyticsPrune }, 500);
}
