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
// Each step is isolated in its own try/catch — a failure in any one must
// never block the ones after it (most importantly, snapshots always run).

import { serverEnv } from "@/lib/marketData/env.server";
import { runExpiryProcessing } from "@/lib/options/expiry.server";
import { runInterestAccrual } from "@/lib/margin/interest.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { runSnapshots } from "./writer.server";

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

  try {
    const summary = await runSnapshots();
    return json({ ok: true, summary, expiry, interest, margin }, 200);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Snapshot run failed.", expiry, interest, margin }, 500);
  }
}
