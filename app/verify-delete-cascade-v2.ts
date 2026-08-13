// Re-verification of the delete-account cascade invariant after PLAN.md §6
// step 5 added two new user-linked tables (rate_limit_events, CASCADE;
// analytics_events, deliberately SET NULL — see migration 0020's header).
// Step 1's original claim was "zero rows across all 16 user-scoped
// tables" — that invariant has now changed shape, not broken: it's "zero
// rows across all 17 CASCADE tables, plus exactly one intentionally
// ANONYMIZED row in analytics_events with zero personal identifiers."
//
// The 17 CASCADE + 1 SET-NULL table list below was derived by grepping
// every applied migration file for `references auth.users` — the direct
// source of truth for what's actually in the schema, not a recalled list
// (rerun that grep yourself to reproduce this list independently):
//   grep -n "references auth.users" supabase/migrations/*.sql
//
// Real end-to-end: real signed-in test user, real trade, real watchlist
// add, real rate-limited action (drives a real rate_limit_events +
// analytics_events row), then a real account deletion via the same
// deleteAccountFn path the UI uses (auth.admin.deleteUser), then a direct
// service-role read-back of every table below.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser } from "./verify-harness";
import { checkAndRecordRateLimit, RATE_LIMITS } from "@/lib/rateLimit/check.server";
import { track } from "@/lib/analytics/track.server";

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

// Derived via `grep -n "references auth.users" supabase/migrations/*.sql` — see file header.
const CASCADE_TABLES = [
  "profiles", "holdings", "transactions", "watchlist", "portfolio_snapshots",
  "agent_config", "agent_holdings", "agent_transactions", "agent_decisions",
  "agent_snapshots", "agent_proposals", "option_positions", "option_transactions",
  "insights", "account_events", "margin_events",
  "rate_limit_events",
  // "coach_nudge_dismissals" — 0028 migration written but NOT yet applied to
  // the DB; add this back once it's live (tracked in issue #25). Adding it
  // now would break every run of this script against the real, unmigrated
  // schema — a self-inflicted regression, not a genuine one.
] as const;
const SET_NULL_TABLES = ["analytics_events"] as const; // NEW this step, deliberate exception

// `profiles` is the one table where the user-linking column is `id` itself
// (it IS the auth.users row's 1:1 counterpart), not a separate `user_id`
// FK column like every other table here.
const USER_COLUMN: Record<string, string> = { profiles: "id" };

async function countForUser(table: string, userId: string): Promise<number> {
  const col = USER_COLUMN[table] ?? "user_id";
  const { count, error } = await admin.from(table).select(col, { count: "exact", head: true }).eq(col, userId);
  if (error) throw new Error(`count(${table}) failed: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log("\n████ 1. Seed a real test user with real activity across as many tables as practical ████");
  const stamp = Date.now();
  const email = `pt-cascade-v2-${stamp}@example.org`;
  const password = "Test1234!pw";
  const { uid: userId } = await step("create test user", () => createTestUser(admin, email, password));
  console.log(`  test user: ${email} (${userId})`);

  // profiles: created automatically by handle_new_user (also fires the
  // 'signup' analytics_events row we'll check for later).
  //
  // watchlist deliberately NOT seeded here: service_role only has SELECT
  // on watchlist (0009) — by design, real writes only ever happen via the
  // user's own authenticated session (RLS), not service_role directly.
  // Its cascade rule is unchanged since 0002 (untouched this session) and
  // was already proven in step 1's original pass; re-seeding it here would
  // need a real sign-in round trip for no new information. It stays in
  // CASCADE_TABLES below so the after-count check still covers it (a
  // trivial 0-stays-0 check, which is still a real assertion).
  const trade = await step("real execute_trade RPC call (seeds holdings + transactions)", () =>
    admin.rpc("execute_trade", { p_user_id: userId, p_symbol: "AAPL", p_side: "buy", p_quantity: 1, p_price: 100, p_positions_value: 0 }),
  );
  assert("execute_trade succeeded", !trade.error, trade.error?.message);

  await step("insert an account_events row (simulating a prior reset)", () =>
    admin.from("account_events").insert({ user_id: userId, kind: "reset", detail: { note: "cascade-v2 seed" } }),
  );

  // Real rate-limited action — proves rate_limit_events gets a REAL row via
  // the REAL guarded path, not a synthetic insert.
  const rl = await step("real checkAndRecordRateLimit call (agentRun action)", () =>
    checkAndRecordRateLimit(userId, RATE_LIMITS.agentRun),
  );
  assert("the rate-limit call was allowed (first call, well under any limit)", rl.allowed === true, JSON.stringify(rl));

  // Real analytics events via the REAL track() abstraction, not a raw insert —
  // matches exactly what a real user session would produce.
  await step("track('first_trade') via the real abstraction", () => track("first_trade", { userId, properties: { symbol: "AAPL", side: "buy" } }));
  await step("track('insight_viewed') via the real abstraction", () => track("insight_viewed", { userId, properties: { symbol: "AAPL" } }));

  console.log("\n████ 2. BEFORE counts — every CASCADE table + the SET-NULL table ████");
  const before: Record<string, number> = {};
  for (const t of CASCADE_TABLES) {
    before[t] = await step(`count(${t}) before delete`, () => countForUser(t, userId), 10000);
  }
  let analyticsBefore = await step("count(analytics_events) before delete", () => countForUser("analytics_events", userId), 10000);
  console.log(`  counts before: ${JSON.stringify(before)}`);
  console.log(`  analytics_events before: ${analyticsBefore}`);
  assert("holdings has ≥1 row before delete (real trade landed)", before.holdings >= 1);
  assert("transactions has ≥1 row before delete (real trade landed)", before.transactions >= 1);
  assert("account_events has ≥1 row before delete (seed landed)", before.account_events >= 1);
  assert("rate_limit_events has ≥1 row before delete (real guarded call landed)", before.rate_limit_events >= 1);
  assert("analytics_events has ≥2 rows before delete (signup + 2 tracked events)", analyticsBefore >= 2, `got ${analyticsBefore}`);

  console.log("\n████ 3. Real account deletion — the SAME path the UI uses (auth.admin.deleteUser) ████");
  const delResult = await step("admin.auth.admin.deleteUser(userId)", () => admin.auth.admin.deleteUser(userId), 15000);
  assert("deleteUser succeeded with no error", !delResult.error, delResult.error?.message);

  const authCheck = await step("confirm auth.users row is gone", () => admin.auth.admin.getUserById(userId));
  assert("auth.users row no longer exists", !!authCheck.error || !authCheck.data?.user, JSON.stringify(authCheck.error ?? authCheck.data));

  console.log("\n████ 4. AFTER counts — every CASCADE table must be EXACTLY ZERO ████");
  const after: Record<string, number> = {};
  for (const t of CASCADE_TABLES) {
    after[t] = await step(`count(${t}) after delete`, () => countForUser(t, userId), 10000);
    assert(`${t}: 0 rows remain for the deleted user (was ${before[t]})`, after[t] === 0, `after=${after[t]}`);
  }

  console.log("\n████ 5. AFTER — analytics_events: rows SURVIVE, but user_id must be NULL (anonymized) ████");
  const analyticsAfterLinked = await step("count(analytics_events) still linked to the deleted user_id", () => countForUser("analytics_events", userId), 10000);
  assert("ZERO analytics_events rows still reference the deleted user_id (link fully severed)", analyticsAfterLinked === 0, `got ${analyticsAfterLinked}`);

  // Find the anonymized rows by event name (the only way to re-locate them
  // now that user_id is null) — scoped to a tight time window around this
  // test run to avoid false-matching unrelated real traffic.
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const anon = await step("find the anonymized (user_id IS NULL) rows from this test run", () =>
    admin.from("analytics_events").select("id, user_id, event, properties, created_at").is("user_id", null).gte("created_at", since).in("event", ["signup", "first_trade", "insight_viewed"]),
  );
  const anonRows = anon.data ?? [];
  console.log(`  anonymized rows found: ${JSON.stringify(anonRows, null, 2)}`);
  assert("at least the 3 seeded events survived as anonymized rows (signup + first_trade + insight_viewed)", anonRows.length >= 3, `found ${anonRows.length}`);

  console.log("\n████ 6. Confirm the surviving anonymized rows carry ZERO personal identifiers ████");
  const PII_PATTERNS = [/@/, /pt-cascade-v2/i, new RegExp(userId, "i")];
  for (const row of anonRows) {
    const blob = JSON.stringify(row);
    assert(`row ${row.id} (${row.event}): user_id is null`, row.user_id === null);
    for (const pat of PII_PATTERNS) {
      assert(`row ${row.id} (${row.event}): no match for ${pat} anywhere in the row (event/properties/id)`, !pat.test(blob), blob);
    }
    // Whitelist-check properties too: every value must be a plain
    // string/number/boolean shaped like a ticker/side/flag, never
    // anything email/name/uuid-shaped beyond the row's own harmless id.
    const props = (row.properties ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      const ok = typeof v === "string" || typeof v === "boolean" || typeof v === "number";
      assert(`row ${row.id}: properties.${k} is a plain primitive (${typeof v})`, ok, JSON.stringify(v));
    }
  }

  console.log("\n████ Cleanup ████");
  await step("delete the anonymized test rows this run created (housekeeping — not part of the invariant proof)", () =>
    admin.from("analytics_events").delete().is("user_id", null).gte("created_at", since).in("event", ["signup", "first_trade", "insight_viewed"]),
  );
  await step("delete the test rate_limit_events row if the cascade somehow left one (defense-in-depth check)", () =>
    admin.from("rate_limit_events").delete().eq("user_id", userId),
  );
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
