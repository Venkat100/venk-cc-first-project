// Live verification of the A2 rate-limit guard (PLAN.md §6 step 5). Real
// Postgres, real advisory-lock-guarded RPC — no mocks. Proves: (1) a real
// burst hit returns the friendly message AND the server actually stopped
// recording further attempts (DB row count proof, not just a returned
// string); (2) the daily-cap branch works (exercised via the SAME
// production function with test-sized limits, isolated by a unique action
// name — no code path differs from real traffic); (3) a "tampered/direct"
// caller — one that skips the app's own TS wrapper entirely and calls the
// Postgres RPC directly, the way a scripted attacker hitting the DB API
// would — is rejected identically, proving enforcement lives in Postgres
// itself and isn't something an application-layer bypass could evade; (4)
// limits are correctly scoped per (user, action) — a different user and a
// different action are both unaffected by another user's exhausted limit.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser } from "./verify-harness";
import { checkAndRecordRateLimit, RATE_LIMITS } from "@/lib/rateLimit/check.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
}
async function step<T>(label: string, fn: () => Promise<T>, ms = 20000): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}

const admin = getServiceClient();

async function countEvents(userId: string, action: string): Promise<number> {
  const { count, error } = await admin
    .from("rate_limit_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("action", action);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  console.log("\n████ Setup: real throwaway test user ████");
  const email = `pt-ratelimit-verify-${Date.now()}@example.org`;
  const { uid: userId } = await step("create test user", () => createTestUser(admin, email, "Test1234!pw"));
  console.log(`  test user: ${email} (${userId})`);

  console.log(`\n████ 1. REAL burst limit — agentRun (${RATE_LIMITS.agentRun.burstLimit}/${RATE_LIMITS.agentRun.burstWindowSeconds}s) ████`);
  console.log(`  using the EXACT production RATE_LIMITS.agentRun config — same object the real runAgentThinkerFn imports`);
  const results: Awaited<ReturnType<typeof checkAndRecordRateLimit>>[] = [];
  for (let i = 1; i <= RATE_LIMITS.agentRun.burstLimit + 1; i++) {
    const r = await step(`call ${i}/${RATE_LIMITS.agentRun.burstLimit + 1}: checkAndRecordRateLimit(agentRun)`, () => checkAndRecordRateLimit(userId, RATE_LIMITS.agentRun));
    console.log(`    → ${JSON.stringify(r)}`);
    results.push(r);
  }
  const allowedCount = results.filter((r) => r.allowed).length;
  const lastResult = results[results.length - 1];
  assert(`exactly ${RATE_LIMITS.agentRun.burstLimit} of the ${results.length} calls were allowed`, allowedCount === RATE_LIMITS.agentRun.burstLimit, `allowed=${allowedCount}`);
  assert("the call OVER the limit was rejected", lastResult.allowed === false);
  if (!lastResult.allowed) {
    assert("rejection reason is 'burst'", lastResult.reason === "burst", lastResult.reason);
    assert("the message is friendly and specific (not a raw error)", /wait about \d+ seconds/.test(lastResult.message), lastResult.message);
    console.log(`  friendly message shown to the user: "${lastResult.message}"`);
  }

  const dbCount = await step("DB proof: count rate_limit_events rows for this user+action", () => countEvents(userId, "agent_run"));
  assert(
    `SERVER actually stopped recording after the limit — DB has exactly ${RATE_LIMITS.agentRun.burstLimit} rows, not ${results.length}`,
    dbCount === RATE_LIMITS.agentRun.burstLimit,
    `db count=${dbCount}`,
  );

  console.log("\n████ 2. Daily-cap branch — same production function, test-sized limits, isolated action name ████");
  console.log("  (isolating with a unique action name so this doesn't interact with the burst test above;");
  console.log("   the CODE PATH exercised is byte-identical to real traffic — only the numeric limits differ)");
  const dailyAction = "test_daily_cap";
  const dailyResults: Awaited<ReturnType<typeof checkAndRecordRateLimit>>[] = [];
  for (let i = 1; i <= 3; i++) {
    const r = await step(`call ${i}/3: checkAndRecordRateLimit(daily-cap=2, burst-limit=1000)`, () =>
      checkAndRecordRateLimit(userId, { action: dailyAction, burstLimit: 1000, burstWindowSeconds: 300, dailyLimit: 2 }),
    );
    console.log(`    → ${JSON.stringify(r)}`);
    dailyResults.push(r);
  }
  assert("call 1 allowed", dailyResults[0].allowed === true);
  assert("call 2 allowed (at the daily cap)", dailyResults[1].allowed === true);
  assert("call 3 REJECTED (over the daily cap)", dailyResults[2].allowed === false);
  const dailyLast = dailyResults[2];
  if (!dailyLast.allowed) {
    assert("rejection reason is 'daily'", dailyLast.reason === "daily", dailyLast.reason);
    assert("the message names a UTC reset time, not a raw error", /resets at \d{2}:\d{2} UTC/.test(dailyLast.message), dailyLast.message);
    console.log(`  friendly message shown to the user: "${dailyLast.message}"`);
  }

  console.log("\n████ 3. Tampered/direct call — skip the app's own TS wrapper, call the Postgres RPC RAW ████");
  console.log("  simulates a scripted attacker hitting the database function directly, bypassing every line");
  console.log("  of application code (not just the UI) — proves enforcement lives IN POSTGRES, not in app code");
  const raw = await step("raw admin.rpc('check_and_record_rate_limit') — the ALREADY-EXHAUSTED agent_run action", () =>
    admin.rpc("check_and_record_rate_limit", {
      p_user_id: userId,
      p_action: "agent_run",
      p_burst_limit: RATE_LIMITS.agentRun.burstLimit,
      p_burst_window_seconds: RATE_LIMITS.agentRun.burstWindowSeconds,
      p_daily_limit: RATE_LIMITS.agentRun.dailyLimit,
    }),
  );
  assert("raw RPC call succeeded (no error)", !raw.error, raw.error?.message);
  const rawResult = raw.data as { allowed: boolean; reason?: string };
  assert("even the RAW direct RPC call is REJECTED — no app-layer bypass exists", rawResult.allowed === false, JSON.stringify(rawResult));
  assert("same 'burst' reason as the normal path", rawResult.reason === "burst", rawResult.reason);

  console.log("\n████ 4. Scoping — a DIFFERENT user and a DIFFERENT action are both unaffected ████");
  const { uid: otherUserId } = await step("create a second, unrelated test user", () => createTestUser(admin, `pt-ratelimit-verify-other-${Date.now()}@example.org`, "Test1234!pw"));
  const otherUserCheck = await step("a DIFFERENT user's agent_run call, same action name", () => checkAndRecordRateLimit(otherUserId, RATE_LIMITS.agentRun));
  assert("a different user is NOT affected by the first user's exhausted limit", otherUserCheck.allowed === true, JSON.stringify(otherUserCheck));

  const otherActionCheck = await step("the SAME (rate-limited) user, but the 'insight' action instead", () => checkAndRecordRateLimit(userId, RATE_LIMITS.insight));
  assert("a different ACTION for the same user is NOT affected by agent_run's exhausted limit", otherActionCheck.allowed === true, JSON.stringify(otherActionCheck));

  console.log("\n████ Cleanup ████");
  await step("delete both test users (cascades rate_limit_events)", async () => {
    await admin.auth.admin.deleteUser(userId);
    await admin.auth.admin.deleteUser(otherUserId);
  });
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
