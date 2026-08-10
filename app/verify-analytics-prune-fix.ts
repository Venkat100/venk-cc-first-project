// Live re-verification of the analytics_events prune AFTER migration 0021
// (the missing DELETE grant fix). The original bug: 0020 granted
// service_role only SELECT+INSERT, so every real cron run's prune step
// silently failed with "permission denied for table analytics_events".
// This proves the fix: insert one deliberately-old row (>90 days) and one
// fresh row, run the REAL runAnalyticsPrune(), confirm the old row is
// gone and the fresh row survives — no more permission error.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { runAnalyticsPrune } from "@/lib/analytics/prune.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}

const admin = getServiceClient();

async function main() {
  console.log("\n████ 1. Seed one OLD row (100 days) and one FRESH row ████");
  const oldEvent = `verify-prune-old-${Date.now()}`;
  const freshEvent = `verify-prune-fresh-${Date.now()}`;
  const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString();
  const nowIso = new Date().toISOString();

  const ins = await admin.from("analytics_events").insert([
    { event: oldEvent, user_id: null, properties: { marker: "old" }, created_at: hundredDaysAgo },
    { event: freshEvent, user_id: null, properties: { marker: "fresh" }, created_at: nowIso },
  ]);
  assert("seed insert succeeded (no error)", !ins.error, ins.error?.message);
  if (ins.error) throw new Error(`Seed failed: ${ins.error.message}`);

  const before = await admin.from("analytics_events").select("event").in("event", [oldEvent, freshEvent]);
  assert("both seeded rows are present before pruning", (before.data ?? []).length === 2, `found ${before.data?.length}`);

  console.log(`\n████ 2. Run the REAL runAnalyticsPrune() — this is what the daily cron calls ████`);
  console.log(`  [${ts()}] → runAnalyticsPrune()`);
  let result;
  try {
    result = await runAnalyticsPrune();
  } catch (e) {
    assert("runAnalyticsPrune() did NOT throw", false, e instanceof Error ? e.message : String(e));
    throw e;
  }
  console.log(`  [${ts()}] ✓ runAnalyticsPrune() completed without error`);
  console.log(`  result: ${JSON.stringify(result)}`);
  assert("runAnalyticsPrune() succeeded (the permission-denied bug is FIXED)", !!result.ranAt);
  assert("deleted count is at least 1 (our old seeded row, possibly plus real old rows)", result.deleted >= 1, `deleted=${result.deleted}`);

  console.log("\n████ 3. Confirm the OLD row is gone and the FRESH row survived ████");
  const oldCheck = await admin.from("analytics_events").select("event").eq("event", oldEvent).maybeSingle();
  const freshCheck = await admin.from("analytics_events").select("event").eq("event", freshEvent).maybeSingle();
  assert("the 100-day-old row was DELETED", !oldCheck.data, JSON.stringify(oldCheck.data));
  assert("the fresh row was NOT deleted (still present)", !!freshCheck.data, JSON.stringify(freshCheck.data));

  console.log("\n████ Cleanup ████");
  await admin.from("analytics_events").delete().eq("event", freshEvent);
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
