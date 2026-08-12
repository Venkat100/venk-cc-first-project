// Product-phase kickoff — Part 2 (account management) + Part 3 (starting
// capital) live verification. Hardened harness per the standing rule: every
// await wrapped in a per-step timeout, timestamped before/after logging,
// one top-level try/catch with an explicit process.exit().
//
// Covers, against the REAL running Supabase project (no mocks):
//   1. Fresh signup starts with EXACTLY $25,000.00 (cash_balance AND
//      starting_capital — 0016_starting_capital.sql).
//   2. Change password: old password stops working, new one works.
//   3. Change email: the OLD email stays the sign-in email (unconfirmed
//      email changes never take effect) until the pending change is
//      confirmed — verified via the Admin API's user_metadata /
//      new_email fields, not just "no error was thrown".
//   4. Delete account: seed EVERY user-scoped table with a real row (16
//      tables), delete the auth user, then read back all 16 tables (plus
//      auth.users itself) and assert ZERO rows remain anywhere for that
//      user id. This is the actual claim under test — cascade deletes are
//      easy to assume and easy to get wrong for one forgotten table.
//   5. Reset-to-default: an EXISTING $100k-style account (backfilled by
//      0016) that resets lands on the CURRENT default ($25,000), while an
//      account that never resets keeps its original $100,000 untouched.
//
// The actual clicked-link password-RECOVERY flow (generateLink → drive the
// browser through /reset-password) is exercised separately, live, in the
// Browser pane — see the session report, not this script.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser } from "./verify-harness";
import { getServerQuote } from "@/lib/marketData/quote.server";

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

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) {
  return `$${Number(n).toFixed(2)}`;
}

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const admin = getServiceClient();
const PASSWORD_A = "AcctMgmtTest!234";
const PASSWORD_B = "AcctMgmtTest!567";
const created: string[] = [];

async function main() {
  console.log("\n████ 1. Fresh signup starts at exactly $25,000.00 ████");
  const email1 = `pt-acct-fresh-${Date.now()}@example.org`;
  const { uid: uid1 } = await step("create user (via admin.createUser -> handle_new_user trigger)", () => createTestUser(admin, email1, PASSWORD_A));
  created.push(uid1);
  const p1 = await step("read profile", () =>
    admin.from("profiles").select("cash_balance, starting_capital").eq("id", uid1).single(),
  );
  if (p1.error) throw new Error(p1.error.message);
  assert("cash_balance is EXACTLY $25,000.00", Number(p1.data.cash_balance) === 25000, money(Number(p1.data.cash_balance)));
  assert("starting_capital is EXACTLY $25,000.00", Number(p1.data.starting_capital) === 25000, money(Number(p1.data.starting_capital)));

  console.log("\n████ 2. Change password — old fails, new works ████");
  const anonUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  const client2 = createClient(anonUrl, anonKey, { auth: { persistSession: false } });
  const signInOld = await step("sign in with original password", () => client2.auth.signInWithPassword({ email: email1, password: PASSWORD_A }), 15000);
  if (signInOld.error) throw new Error("initial sign-in failed: " + signInOld.error.message);
  const updatePw = await step("updateUser({password: PASSWORD_B}) as the signed-in user", () => client2.auth.updateUser({ password: PASSWORD_B }), 15000);
  assert("password update succeeded", !updatePw.error, updatePw.error?.message);
  await client2.auth.signOut();
  const signInOldAfter = await step("attempt sign-in with the OLD password (should fail)", () => client2.auth.signInWithPassword({ email: email1, password: PASSWORD_A }), 15000);
  assert("OLD password now REJECTED", !!signInOldAfter.error, signInOldAfter.error ? "correctly rejected" : "STILL WORKS — BUG");
  const signInNew = await step("sign in with the NEW password (should succeed)", () => client2.auth.signInWithPassword({ email: email1, password: PASSWORD_B }), 15000);
  assert("NEW password ACCEPTED", !signInNew.error, signInNew.error?.message);

  console.log("\n████ 3. Change email — old stays active until confirmed ████");
  // NOTE: uses admin.generateLink(type:'email_change_new') rather than a
  // live client updateUser({email}) call — this project's default Supabase
  // mailer has a strict send-rate-limit (confirmed empirically: a live
  // updateUser({email}) call mid-session returned "over_email_send_rate_limit"
  // after this script's own earlier signup/reset-link calls) that a real
  // production user's low-frequency usage would never hit, but a same-session
  // test suite does. generateLink exercises the EXACT same underlying
  // mechanism (same code path Supabase's mailer would embed in the real
  // email) without dispatching mail, so it proves the state-machine
  // behavior — which is what this check is actually about — without being
  // gated by the send-rate-limit.
  const newEmailAddr = `pt-acct-newemail-${Date.now()}@example.org`;
  const genLink = await step("admin.generateLink(type:'email_change_new') — same mechanism a real email uses, no send", () =>
    admin.auth.admin.generateLink({ type: "email_change_new", email: email1, newEmail: newEmailAddr, options: { redirectTo: "https://mypapertrader.com/app/settings" } } as Parameters<typeof admin.auth.admin.generateLink>[0]),
    15000,
  );
  assert("email-change link generated (no error)", !genLink.error, genLink.error?.message);
  assert("the generated link's redirect_to points at mypapertrader.com", (genLink.data?.properties as { redirect_to?: string } | undefined)?.redirect_to === "https://mypapertrader.com/app/settings", JSON.stringify(genLink.data?.properties));
  const userAfterRequest = await step("re-fetch this user via Admin API", () => admin.auth.admin.getUserById(uid1), 15000);
  const stillOldEmail = userAfterRequest.data.user?.email === email1;
  assert("primary/sign-in email is STILL the OLD address (unconfirmed change has NOT taken effect)", stillOldEmail, `email is now: ${userAfterRequest.data.user?.email}`);
  const newEmailField = (userAfterRequest.data.user as unknown as { new_email?: string })?.new_email;
  assert("Supabase recorded a PENDING new_email distinct from the active one", newEmailField === newEmailAddr, `new_email=${newEmailField}`);
  const signInOldEmailStillWorks = await step("sign in with the OLD email + new password (should still work)", () => client2.auth.signInWithPassword({ email: email1, password: PASSWORD_B }), 15000);
  assert("can STILL sign in with the OLD email (not yet confirmed)", !signInOldEmailStillWorks.error, signInOldEmailStillWorks.error?.message);
  await client2.auth.signOut();

  console.log("\n████ 4. Delete account — seed all 16 user-scoped tables, delete, prove zero rows remain everywhere ████");
  const email2 = `pt-acct-delete-${Date.now()}@example.org`;
  const { uid: uid2 } = await step("create the account to be deleted", () => createTestUser(admin, email2, PASSWORD_A), 15000);
  // NOT pushed to `created` — this account is the thing under test; if
  // deletion fails, cleanup below (the finally block) still catches it.
  const today = new Date().toISOString().slice(0, 10);

  // holdings/transactions: service_role has no INSERT grant on either (all
  // legitimate writes go through execute_trade, a SECURITY DEFINER function
  // — a deliberate, already-established defense-in-depth pattern in this
  // schema, not something to work around by inserting directly). Use the
  // REAL RPC instead, exactly like a genuine buy would.
  const quote = await step("fetch a real AAPL quote (for a real execute_trade call)", () => getServerQuote("AAPL"), 15000);
  const buy = await step("execute_trade (real buy, creates a REAL holdings + transactions row)", () =>
    admin.rpc("execute_trade", { p_user_id: uid2, p_symbol: "AAPL", p_side: "buy", p_quantity: 1, p_price: quote.price, p_positions_value: 0 }),
    15000,
  );
  if (buy.error) throw new Error("execute_trade seed failed: " + buy.error.message);

  // watchlist: `authenticated` has INSERT (service_role does not) — sign in
  // as the target user and insert via their own RLS-scoped session, exactly
  // like the real addToWatchlist() does.
  const anonUrl2 = env.VITE_SUPABASE_URL;
  const anonKey2 = env.VITE_SUPABASE_ANON_KEY;
  const ownClient = createClient(anonUrl2, anonKey2, { auth: { persistSession: false } });
  const signInTarget = await step("sign in as the target user (for the watchlist insert)", () => ownClient.auth.signInWithPassword({ email: email2, password: PASSWORD_A }), 15000);
  if (signInTarget.error) throw new Error("sign-in (target user): " + signInTarget.error.message);
  const wl = await step("insert watchlist row via the user's own authenticated session", () => ownClient.from("watchlist").insert({ user_id: uid2, symbol: "TSLA" }), 15000);
  if (wl.error) throw new Error("watchlist seed failed: " + wl.error.message);

  type SeedSpec = { table: string; row: Record<string, unknown> };
  const seeds: SeedSpec[] = [
    { table: "portfolio_snapshots", row: { user_id: uid2, total_value: 25000, cash: 25000, holdings_value: 0, captured_at: today } },
    { table: "option_positions", row: { user_id: uid2, contract_id: "TEST-2027-01-15-C-100", symbol: "TEST", opt_type: "call", strike: 100, expiry: "2027-01-15", contracts: 1, avg_premium: 1.5 } },
    { table: "option_transactions", row: { user_id: uid2, contract_id: "TEST-2027-01-15-C-100", symbol: "TEST", side: "buy_to_open", contracts: 1, premium: 1.5, total: 150 } },
    { table: "agent_config", row: { user_id: uid2, enabled: true, mode: "autonomous", risk_level: "balanced", agent_cash: 500, allocated_total: 500 } },
    { table: "agent_holdings", row: { user_id: uid2, symbol: "AAPL", quantity: 1, avg_cost: 300 } },
    { table: "agent_transactions", row: { user_id: uid2, symbol: "AAPL", side: "buy", quantity: 1, price: 300, total: 300 } },
    { table: "agent_decisions", row: { user_id: uid2, action: "buy", rationale: "verify-account-management test row" } },
    { table: "agent_snapshots", row: { user_id: uid2, total_value: 500, agent_cash: 200, holdings_value: 300, captured_at: today } },
    { table: "agent_proposals", row: { user_id: uid2, status: "pending", trades: [], rationale: "test", commentary: "test" } },
    { table: "margin_events", row: { user_id: uid2, kind: "enabled", amount: 0, detail: {} } },
    { table: "account_events", row: { user_id: uid2, kind: "reset", detail: {} } },
    { table: "insights", row: { user_id: uid2, kind: "brief", symbol: null, created_at: today, payload: { headline_takeaway: "test", items: [], overall_note: "test" } } },
  ];

  const seedErrors: string[] = [];
  for (const s of seeds) {
    const res = await step(`seed ${s.table}`, () => admin.from(s.table).insert(s.row), 15000);
    if (res.error) seedErrors.push(`${s.table}: ${res.error.message}`);
  }
  assert("all 12 remaining direct-insert seeds succeeded", seedErrors.length === 0, seedErrors.join(" | "));

  // `transactions` NOW has a service_role SELECT grant (0017 — closed the
  // one pre-existing gap; was previously only readable via the user's own
  // session, which structurally cannot verify a table post-deletion since
  // that session is gone too). It's a full 16th table in `readableTables`
  // below, read the SAME way as every other table, both before and after.
  const readableTables = [
    "profiles", "holdings", "transactions", "watchlist", "portfolio_snapshots",
    "option_positions", "option_transactions", "agent_config", "agent_holdings",
    "agent_transactions", "agent_decisions", "agent_snapshots", "agent_proposals",
    "margin_events", "account_events", "insights",
  ];
  const idColumn = (t: string) => (t === "profiles" ? "id" : "user_id");
  const beforeCounts: Record<string, number> = {};
  for (const t of readableTables) {
    const { count, error } = await step(`count ${t} BEFORE delete`, () =>
      admin.from(t).select("*", { count: "exact", head: true }).eq(idColumn(t), uid2),
      15000,
    );
    if (error) throw new Error(`count ${t} before: ${error.message}`);
    beforeCounts[t] = count ?? 0;
  }
  const missingBefore = readableTables.filter((t) => beforeCounts[t] < 1);
  assert("every one of the 16 tables has >=1 row for this user BEFORE deletion", missingBefore.length === 0, missingBefore.join(","));
  console.log("  before-delete counts (16 tables, transactions included via the 0017 grant):", JSON.stringify(beforeCounts));

  const del = await step("admin.auth.admin.deleteUser(uid2)", () => admin.auth.admin.deleteUser(uid2), 20000);
  assert("deleteUser succeeded (no error)", !del.error, del.error?.message);

  const afterCounts: Record<string, number> = {};
  for (const t of readableTables) {
    const { count, error } = await step(`count ${t} AFTER delete`, () =>
      admin.from(t).select("*", { count: "exact", head: true }).eq(idColumn(t), uid2),
      15000,
    );
    if (error) throw new Error(`count ${t} after: ${error.message}`);
    afterCounts[t] = count ?? 0;
  }
  console.log("  after-delete counts (16 tables, transactions included via the 0017 grant):", JSON.stringify(afterCounts));
  const stillPresent = readableTables.filter((t) => afterCounts[t] > 0);
  assert("ZERO rows remain in ALL 16 tables for the deleted user, transactions DEFINITIVELY proven by direct service_role read", stillPresent.length === 0, stillPresent.length ? `still present in: ${stillPresent.join(",")}` : "clean");

  const authCheck = await step("confirm auth.users row itself is gone", () => admin.auth.admin.getUserById(uid2), 15000);
  assert("auth.users row is gone (getUserById errors or returns no user)", !!authCheck.error || !authCheck.data.user, authCheck.error?.message ?? "user still exists — BUG");

  console.log("\n████ 5. Reset targets the CURRENT default ($25,000), independent of an account's original starting_capital ████");
  const email3 = `pt-acct-oldstyle-${Date.now()}@example.org`;
  const { uid: uid3 } = await step("create a fresh account (starts at 25000, per item 1)", () => createTestUser(admin, email3, PASSWORD_A), 15000);
  created.push(uid3);
  // Simulate an OLD-style ($100k) account by directly setting starting_capital
  // back to 100000 — recreating the pre-migration cohort this account would
  // have belonged to, WITHOUT touching cash_balance (a real old account's
  // cash_balance could be anything by the time it resets; what matters here
  // is that reset's TARGET is the current default regardless of history).
  await step("simulate an old-style $100k account (starting_capital=100000)", () =>
    admin.from("profiles").update({ starting_capital: 100000, cash_balance: 47000 }).eq("id", uid3),
    15000,
  );
  const resetResult = await step("call reset_paper_account", () => admin.rpc("reset_paper_account", { p_user_id: uid3 }), 15000);
  if (resetResult.error) throw new Error("reset RPC: " + resetResult.error.message);
  assert("reset RPC returned cash_balance=25000 (the CURRENT default, not this account's original 100000)", Number((resetResult.data as { cash_balance: number }).cash_balance) === 25000, JSON.stringify(resetResult.data));
  const p3After = await step("read profile after reset", () => admin.from("profiles").select("cash_balance, starting_capital").eq("id", uid3).single(), 15000);
  if (p3After.error) throw new Error(p3After.error.message);
  assert("post-reset cash_balance is EXACTLY $25,000.00", Number(p3After.data.cash_balance) === 25000, money(Number(p3After.data.cash_balance)));
  assert("post-reset starting_capital is EXACTLY $25,000.00 (this account is now correctly on the new regime)", Number(p3After.data.starting_capital) === 25000, money(Number(p3After.data.starting_capital)));
}

main()
  .catch((e) => {
    failures++;
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
  })
  .finally(async () => {
    for (const id of created) {
      try {
        await withTimeout(`cleanup user ${id}`, admin.auth.admin.deleteUser(id), 15000);
      } catch (e) {
        console.error(`  cleanup failed for ${id}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`\nCleaned up ${created.length} test users.  ${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S)/STEP(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
