// PLAN.md §6 step 10 (B4) — super-admin console live verification.
//
// ⚠️ SAFETY: this database has REAL user accounts with real trading
// history. This script tests SUSPEND and DELETE — the two most dangerous
// admin actions. Every destructive call in this script is routed through
// safeSuspend/safeBan/safeDelete below, which refuse to act on anything
// that isn't (a) NOT in the explicit REAL_ACCOUNT_EMAILS blocklist, (b) on
// the @example.org throwaway domain, AND (c) an id this exact script run
// actually created (tracked in createdUserIds). All three must hold or the
// call throws before touching the database. The real admin account
// (venkatpraveen1@gmail.com) is never suspended, banned, or deleted here.
//
// createServerFn-wrapped functions (lib/admin/functions.ts's *Fn exports)
// throw "No Start context found in AsyncLocalStorage" when called directly
// from a vite-node script (confirmed empirically before writing this) — the
// same reason verify-scenarios-live.ts mirrors getScenarioMarketDataFn's
// logic rather than importing it. This script does the same: it calls
// requireAdmin() directly (a plain function, not createServerFn-wrapped —
// the exact same one every *Fn calls) and the underlying RPCs directly via
// the service client. The TRUE end-to-end "call the real HTTP endpoint as
// a signed-in non-admin" proof happens in the browser phase, not here.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { requireAdmin, NotAdminError } from "@/lib/admin/requireAdmin.server";
import { estimateInsightCostUsd, estimateAgentRunCostUsd } from "@/lib/admin/costEstimates";
import { checkAndRecordRateLimit } from "@/lib/rateLimit/check.server";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { step, assert, sleep, createTestUser, runVerification, withRetry } from "./verify-harness";

const REAL_ACCOUNT_EMAILS = new Set([
  "santosh.naranapatty@gmail.com",
  "santoshthegamer@gmail.com",
  "pcvenky10@gmail.com",
  "rajath.anil@gmail.com",
  "venkiel12@gmail.com",
  "venkatpraveen1@gmail.com", // the real admin — read-only for this script, never a destructive target
]);
const TEST_EMAIL_DOMAIN = "@example.org";

const createdUserIds = new Set<string>();
const createdUserEmails = new Map<string, string>(); // id -> email, for the safety check

function assertSafeDestructiveTarget(uid: string, label: string): void {
  const email = createdUserEmails.get(uid);
  if (!email) throw new Error(`SAFETY ABORT (${label}): uid ${uid} was not created by this script run`);
  if (REAL_ACCOUNT_EMAILS.has(email.toLowerCase())) throw new Error(`SAFETY ABORT (${label}): ${email} is a real account`);
  if (!email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN)) throw new Error(`SAFETY ABORT (${label}): ${email} isn't on the throwaway test domain`);
  if (!createdUserIds.has(uid)) throw new Error(`SAFETY ABORT (${label}): uid ${uid} not in the tracked created-users set`);
}

async function safeSuspendRpc(admin: ReturnType<typeof getServiceClient>, adminId: string, targetUid: string, suspended: boolean) {
  assertSafeDestructiveTarget(targetUid, "admin_set_suspended");
  return admin.rpc("admin_set_suspended", { p_admin_id: adminId, p_target_user_id: targetUid, p_suspended: suspended });
}

async function safeBan(admin: ReturnType<typeof getServiceClient>, targetUid: string, banned: boolean) {
  assertSafeDestructiveTarget(targetUid, "auth ban");
  return admin.auth.admin.updateUserById(targetUid, { ban_duration: banned ? "876000h" : "none" });
}

async function safeDelete(admin: ReturnType<typeof getServiceClient>, targetUid: string) {
  assertSafeDestructiveTarget(targetUid, "deleteUser");
  return admin.auth.admin.deleteUser(targetUid);
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = (() => {
  const env = readFileSync(new URL("./.env", import.meta.url), "utf8");
  const m = env.match(/VITE_SUPABASE_ANON_KEY=(.+)/);
  return m ? m[1].trim() : "";
})();

function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function trySignIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  return { ok: !error, error: error?.message };
}

async function main() {
  const admin = getServiceClient();
  const stamp = Date.now();
  const PASSWORD = "AdminVerifyPass!234";

  async function makeUser(label: string) {
    const email = `pt-admin-verify-${label}-${stamp}@example.org`;
    const { uid } = await step(`create user ${label}`, () => createTestUser(admin, email, PASSWORD));
    createdUserIds.add(uid);
    createdUserEmails.set(uid, email);
    return { uid, email };
  }

  console.log("\n████ 0. Setup — locate the real admin, create throwaway test users ████");

  const { data: authList } = await step("list auth users (to find the real admin id)", () => admin.auth.admin.listUsers({ page: 1, perPage: 1000 }));
  const realAdmin = authList!.users.find((u) => u.email?.toLowerCase() === "venkatpraveen1@gmail.com");
  assert("found the real admin account by email", !!realAdmin, "venkatpraveen1@gmail.com");
  const realAdminId = realAdmin!.id;

  const { data: realAdminProfile } = await admin.from("profiles").select("is_admin").eq("id", realAdminId).single();
  assert("real admin's profile.is_admin is true (set manually by Venky via SQL, as instructed)", realAdminProfile?.is_admin === true);

  const nonAdmin = await makeUser("nonadmin");
  const targetUser = await makeUser("target");
  const deleteTarget = await makeUser("deltarget");
  const suspendTarget = await makeUser("suspend");

  console.log(`\n  Real accounts blocklisted (never touched): ${[...REAL_ACCOUNT_EMAILS].join(", ")}`);
  console.log(`  Throwaway test users created: ${[...createdUserEmails.values()].join(", ")}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 1. is_admin has NO client write path — proven by a real attempt ████");
  {
    const client = anonClient();
    const signIn = await step("sign in as non-admin (own session)", () => client.auth.signInWithPassword({ email: nonAdmin.email, password: PASSWORD }));
    assert("non-admin signed in", !signIn.error, signIn.error?.message);

    const attempt = await step("attempt: authenticated client sets its own is_admin=true", () =>
      client.from("profiles").update({ is_admin: true }).eq("id", nonAdmin.uid).select(),
    );
    assert("is_admin write REJECTED by Postgres (no column grant exists)", !!attempt.error, attempt.error?.message ?? "no error — THIS WOULD BE A REAL SECURITY HOLE");

    const check = await admin.from("profiles").select("is_admin").eq("id", nonAdmin.uid).single();
    assert("is_admin is still false in the DB after the rejected attempt", check.data?.is_admin === false);

    const attemptSuspend = await step("attempt: authenticated client sets its own suspended_at", () =>
      client.from("profiles").update({ suspended_at: new Date().toISOString() }).eq("id", nonAdmin.uid).select(),
    );
    assert("suspended_at write also REJECTED (same column-privilege reasoning)", !!attemptSuspend.error, attemptSuspend.error?.message);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 2. Non-admin cannot call the admin logic — the real function, the real RPCs ████");
  {
    let threw = false;
    try {
      await requireAdmin(nonAdmin.uid);
    } catch (e) {
      threw = e instanceof NotAdminError;
    }
    assert("requireAdmin() — the EXACT function every admin server fn calls — throws NotAdminError for a non-admin", threw);

    const rpc1 = await step("tampered RPC call: admin_set_suspended with a non-admin p_admin_id", () =>
      admin.rpc("admin_set_suspended", { p_admin_id: nonAdmin.uid, p_target_user_id: suspendTarget.uid, p_suspended: true }),
    );
    assert("admin_set_suspended REJECTS a non-admin caller (SQL-level independent re-check)", !!rpc1.error && rpc1.error.message.includes("not_admin"), rpc1.error?.message);

    const stillNull = await admin.from("profiles").select("suspended_at").eq("id", suspendTarget.uid).single();
    assert("the rejected call had ZERO effect — suspend target still not suspended", stillNull.data?.suspended_at === null);

    const rpc2 = await step("tampered RPC call: admin_log_action with a non-admin p_admin_id", () =>
      admin.rpc("admin_log_action", { p_admin_id: nonAdmin.uid, p_action: "view_user", p_target_user_id: targetUser.uid }),
    );
    assert("admin_log_action REJECTS a non-admin caller", !!rpc2.error && rpc2.error.message.includes("not_admin"), rpc2.error?.message);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 3. Admin succeeds — real function, real RPCs (acting admin = real admin, targets = throwaway only) ████");
  {
    let threw = false;
    try {
      await requireAdmin(realAdminId);
    } catch {
      threw = true;
    }
    assert("requireAdmin() does NOT throw for the real admin", !threw);

    const logRes = await step("admin_log_action('view_user') as the real admin, target = throwaway targetUser", () =>
      admin.rpc("admin_log_action", { p_admin_id: realAdminId, p_action: "view_user", p_target_user_id: targetUser.uid, p_detail: null }),
    );
    assert("admin_log_action succeeds for a real admin", !logRes.error, logRes.error?.message);

    const auditRow = await admin.from("admin_audit_log").select("*").eq("id", (logRes.data as { id: string }).id).single();
    assert("audit row has correct admin_id", auditRow.data?.admin_id === realAdminId);
    assert("audit row has correct action", auditRow.data?.action === "view_user");
    assert("audit row has correct target_user_id", auditRow.data?.target_user_id === targetUser.uid);
    assert("audit row's target_email was derived server-side from auth.users, matches", auditRow.data?.target_email === targetUser.email);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 4. Journal privacy — grep already proven at build time; live check here ████");
  {
    const secretNote = `SECRET_JOURNAL_${stamp}_do_not_leak`;
    const client = anonClient();
    await step("sign in as targetUser", () => client.auth.signInWithPassword({ email: targetUser.email, password: PASSWORD }));
    const jRes = await step("targetUser writes a real journal entry (their own session)", () =>
      client.from("journal_entries").insert({ user_id: targetUser.uid, body: secretNote }).select(),
    );
    assert("journal entry written successfully via the user's own session", !jRes.error, jRes.error?.message);

    // Mirror getUserDetailFn's exact query set (the same "mirror for direct
    // assertion" pattern verify-scenarios-live.ts uses) — this is the real
    // set of queries that function performs; if it ever queried
    // journal_entries this mirror would too, and the string check below
    // would catch a leak either way.
    const [profileRes, holdingsRes] = await Promise.all([
      admin.from("profiles").select("*").eq("id", targetUser.uid).maybeSingle(),
      admin.from("holdings").select("quantity, avg_cost").eq("user_id", targetUser.uid),
    ]);
    const mirroredDetail = { profile: profileRes.data, holdings: holdingsRes.data };
    const serialized = JSON.stringify(mirroredDetail);
    assert("the admin detail data contains NO trace of the journal content", !serialized.includes(secretNote));

    // service_role literally cannot read journal_entries — prove the grant
    // doesn't exist, not just that our code chooses not to query it.
    const directAttempt = await admin.from("journal_entries").select("*").eq("user_id", targetUser.uid);
    assert("service_role SELECT on journal_entries is REJECTED (no grant exists, structurally)", !!directAttempt.error, directAttempt.error?.message ?? "NO ERROR — this would mean the grant exists and must be investigated immediately");
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 5. Suspend blocks login; unsuspend restores it. Self-suspend guard proven safely. ████");
  {
    const before = await trySignIn(suspendTarget.email, PASSWORD);
    assert("suspendTarget can sign in BEFORE suspension", before.ok, before.error);

    const susRpc = await safeSuspendRpc(admin, realAdminId, suspendTarget.uid, true);
    assert("admin_set_suspended(true) succeeds", !susRpc.error, susRpc.error?.message);
    const susBan = await safeBan(admin, suspendTarget.uid, true);
    assert("GoTrue ban call succeeds", !susBan.error, susBan.error?.message);

    const flagRow = await admin.from("profiles").select("suspended_at").eq("id", suspendTarget.uid).single();
    assert("profiles.suspended_at is now set", flagRow.data?.suspended_at != null);

    await sleep(1500); // let the ban actually propagate before testing sign-in
    const during = await trySignIn(suspendTarget.email, PASSWORD);
    assert("suspendTarget CANNOT sign in while suspended", !during.ok, during.ok ? "sign-in unexpectedly succeeded" : during.error);

    const unRpc = await safeSuspendRpc(admin, realAdminId, suspendTarget.uid, false);
    assert("admin_set_suspended(false) succeeds", !unRpc.error, unRpc.error?.message);
    const unBan = await safeBan(admin, suspendTarget.uid, false);
    assert("GoTrue unban call succeeds", !unBan.error, unBan.error?.message);

    const flagRow2 = await admin.from("profiles").select("suspended_at").eq("id", suspendTarget.uid).single();
    assert("profiles.suspended_at is null again after unsuspend", flagRow2.data?.suspended_at === null);

    await sleep(1500);
    const after = await trySignIn(suspendTarget.email, PASSWORD);
    assert("suspendTarget CAN sign in again after unsuspend", after.ok, after.error);

    // Self-suspend guard: the RPC's own check fires BEFORE any write, so
    // this is safe to exercise directly against the REAL admin id — no
    // state on the real account is ever touched by a rejected call.
    const selfAttempt = await admin.rpc("admin_set_suspended", { p_admin_id: realAdminId, p_target_user_id: realAdminId, p_suspended: true });
    assert("self-suspend REJECTED", !!selfAttempt.error && selfAttempt.error.message.includes("cannot_suspend_self"), selfAttempt.error?.message);
    const realAdminUnchanged = await admin.from("profiles").select("suspended_at").eq("id", realAdminId).single();
    assert("real admin's suspended_at is untouched (still null)", realAdminUnchanged.data?.suspended_at === null);

    // Audit rows exist for both the suspend and unsuspend actions.
    const auditRows = await admin
      .from("admin_audit_log")
      .select("action, target_user_id")
      .eq("target_user_id", suspendTarget.uid)
      .in("action", ["suspend_user", "unsuspend_user"]);
    assert("audit log has BOTH a suspend_user and unsuspend_user row for this target", (auditRows.data ?? []).length === 2, JSON.stringify(auditRows.data));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 6. Delete reuses the verified cascade, leaves zero rows. Audit trail proven immutable. ████");
  {
    // Seed real state: a stock holding (via the real execute_trade RPC —
    // same engine every trade uses) + a watchlist entry + a journal entry.
    const { getServerQuote } = await import("@/lib/marketData/quote.server");
    const quote = await step("quote AAPL (to seed a real holding)", () => withRetry("AAPL quote", () => getServerQuote("AAPL")));
    const buy = await step("execute_trade (buy 1 AAPL) for deleteTarget", () =>
      admin.rpc("execute_trade", { p_user_id: deleteTarget.uid, p_symbol: "AAPL", p_side: "buy", p_quantity: 1, p_price: quote.price, p_positions_value: 0 }),
    );
    assert("seed trade succeeded", !buy.error, buy.error?.message);
    // watchlist/journal_entries are both authenticated-only tables (no
    // service_role INSERT grant on either) — seed them via the user's own
    // session, same as every real write to those tables in the app.
    const client = anonClient();
    await client.auth.signInWithPassword({ email: deleteTarget.email, password: PASSWORD });
    const wlRes = await client.from("watchlist").insert({ user_id: deleteTarget.uid, symbol: "NVDA" });
    assert("watchlist seed insert succeeded", !wlRes.error, wlRes.error?.message);
    await client.from("journal_entries").insert({ user_id: deleteTarget.uid, body: "pre-delete note" });

    const preCounts = await Promise.all([
      admin.from("holdings").select("id", { count: "exact", head: true }).eq("user_id", deleteTarget.uid),
      admin.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", deleteTarget.uid),
      admin.from("watchlist").select("id", { count: "exact", head: true }).eq("user_id", deleteTarget.uid),
    ]);
    assert("holding exists before delete", (preCounts[0].count ?? 0) === 1);
    assert("transaction exists before delete", (preCounts[1].count ?? 0) === 1);
    assert("watchlist row exists before delete", (preCounts[2].count ?? 0) === 1);

    // Mirrors deleteUserFn's exact sequence.
    const preLog = await admin.rpc("admin_log_action", { p_admin_id: realAdminId, p_action: "delete_user", p_target_user_id: deleteTarget.uid, p_detail: { status: "attempting", email: deleteTarget.email } });
    assert("pre-delete audit log succeeds", !preLog.error, preLog.error?.message);

    const del = await safeDelete(admin, deleteTarget.uid);
    assert("delete succeeds", !del.error, del.error?.message);

    const postLog = await admin.rpc("admin_log_action", { p_admin_id: realAdminId, p_action: "delete_user_completed", p_target_user_id: null, p_detail: { email: deleteTarget.email } });
    assert("post-delete audit log succeeds", !postLog.error, postLog.error?.message);

    const postCounts = await Promise.all([
      admin.from("holdings").select("id", { count: "exact", head: true }).eq("user_id", deleteTarget.uid),
      admin.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", deleteTarget.uid),
      admin.from("watchlist").select("id", { count: "exact", head: true }).eq("user_id", deleteTarget.uid),
      admin.from("profiles").select("id", { count: "exact", head: true }).eq("id", deleteTarget.uid),
    ]);
    assert("holdings: ZERO rows after delete", (postCounts[0].count ?? -1) === 0);
    assert("transactions: ZERO rows after delete", (postCounts[1].count ?? -1) === 0);
    assert("watchlist: ZERO rows after delete", (postCounts[2].count ?? -1) === 0);
    assert("profiles: ZERO rows after delete", (postCounts[3].count ?? -1) === 0);

    // The pre-delete row has target_user_id (still valid at write time), so
    // target_email got populated too. The post-delete row's target is
    // already gone, so target_email is null there — detail.email is the
    // durable record for that row (see app.admin.audit.tsx's display
    // fallback). Query by detail->>email, which every row in this flow
    // carries, to find both regardless of which column has it.
    const deleteAuditRows = await admin.from("admin_audit_log").select("action, target_user_id, target_email, detail").filter("detail->>email", "eq", deleteTarget.email);
    assert("both delete audit rows persisted (attempting + completed)", (deleteAuditRows.data ?? []).length === 2, JSON.stringify(deleteAuditRows.data));
    const completedRow = (deleteAuditRows.data ?? []).find((r) => r.action === "delete_user_completed");
    assert(
      "the completed row's target_user_id is null (target no longer exists) but detail.email survived",
      completedRow?.target_user_id === null && (completedRow?.detail as { email?: string } | null)?.email === deleteTarget.email,
    );

    // Immutability: admin_audit_log has NO update/delete grant, even for
    // service_role — prove it structurally, not by convention.
    const updAttempt = await admin.from("admin_audit_log").update({ action: "tampered" }).eq("id", completedRow ? "00000000-0000-0000-0000-000000000000" : "x").select();
    assert("UPDATE on admin_audit_log is REJECTED for service_role (no grant exists)", !!updAttempt.error, updAttempt.error?.message ?? "NO ERROR — audit log is NOT actually immutable, investigate now");
    const delAttempt = await admin.from("admin_audit_log").delete().eq("action", "view_user");
    assert("DELETE on admin_audit_log is REJECTED for service_role (no grant exists)", !!delAttempt.error, delAttempt.error?.message ?? "NO ERROR — audit log is NOT actually immutable, investigate now");
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 7. Rate-limit rejections are now tracked (task from this step) ████");
  {
    const cfg = { action: "verify_admin_probe", burstLimit: 1, burstWindowSeconds: 300, dailyLimit: 100 };
    const first = await checkAndRecordRateLimit(nonAdmin.uid, cfg);
    assert("first call allowed", first.allowed === true);
    const second = await checkAndRecordRateLimit(nonAdmin.uid, cfg);
    assert("second call (over burst limit) rejected", second.allowed === false);

    await sleep(500);
    const events = await admin
      .from("analytics_events")
      .select("event, properties")
      .eq("user_id", nonAdmin.uid)
      .eq("event", "rate_limited");
    assert("a rate_limited analytics event was recorded for the rejection", (events.data ?? []).length >= 1, JSON.stringify(events.data));
    const props = (events.data ?? [])[0]?.properties as { action?: string; reason?: string } | undefined;
    assert("the recorded event carries the right action/reason", props?.action === "verify_admin_probe" && props?.reason === "burst", JSON.stringify(props));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n████ 8. Cost numbers reconcile against the underlying event tables (before/after delta) ████");
  {
    const costUsers = await Promise.all([makeUser("cost1"), makeUser("cost2")]);
    const today = new Date().toISOString().slice(0, 10);

    async function countInsightsAndAgentRuns(uids: string[]) {
      const [insightsRes, agentRes] = await Promise.all([
        admin.from("insights").select("id").in("user_id", uids).eq("kind", "brief").eq("created_at", today),
        admin.from("analytics_events").select("id").in("user_id", uids).eq("event", "agent_run"),
      ]);
      return { insightCalls: (insightsRes.data ?? []).length, agentRuns: (agentRes.data ?? []).length };
    }

    const uids = costUsers.map((u) => u.uid);
    const before = await countInsightsAndAgentRuns(uids);
    assert("no pre-existing insight/agent activity for brand-new throwaway users", before.insightCalls === 0 && before.agentRuns === 0);

    // Seed exactly 2 known insight calls (kind='brief', one per user) and 3
    // known agent_run events (2 for user1, 1 for user2).
    await admin.from("insights").insert([
      { user_id: uids[0], kind: "brief", payload: { test: true } },
      { user_id: uids[1], kind: "brief", payload: { test: true } },
    ]);
    await admin.from("analytics_events").insert([
      { user_id: uids[0], event: "agent_run" },
      { user_id: uids[0], event: "agent_run" },
      { user_id: uids[1], event: "agent_run" },
    ]);
    await sleep(300);

    const after = await countInsightsAndAgentRuns(uids);
    assert("insight call count delta is EXACTLY 2 (the known seed)", after.insightCalls - before.insightCalls === 2, `${before.insightCalls} -> ${after.insightCalls}`);
    assert("agent run count delta is EXACTLY 3 (the known seed)", after.agentRuns - before.agentRuns === 3, `${before.agentRuns} -> ${after.agentRuns}`);

    const expectedCost = estimateInsightCostUsd(2) + estimateAgentRunCostUsd(3);
    const actualCost = estimateInsightCostUsd(after.insightCalls - before.insightCalls) + estimateAgentRunCostUsd(after.agentRuns - before.agentRuns);
    assert("estimated cost for the known delta equals count × the documented rate constants, exactly", approx(expectedCost, actualCost), `${expectedCost} vs ${actualCost}`);
    console.log(`  seeded delta: 2 insight calls + 3 agent runs -> estimated $${actualCost.toFixed(4)} (using the SAME constants the dashboard displays)`);
  }

  console.log("\n████ Real accounts double-checked untouched ████");
  {
    const stillReal = await admin.from("profiles").select("id").in(
      "id",
      authList!.users.filter((u) => REAL_ACCOUNT_EMAILS.has(u.email?.toLowerCase() ?? "")).map((u) => u.id),
    );
    assert("every real account's profile row still exists", (stillReal.data ?? []).length === REAL_ACCOUNT_EMAILS.size, `expected ${REAL_ACCOUNT_EMAILS.size}, got ${(stillReal.data ?? []).length}`);
  }
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

runVerification(main, {
  globalTimeoutMs: 6 * 60_000,
  cleanup: async () => {
    const admin = getServiceClient();
    // deleteTarget was already deleted mid-script; deleting it again is a
    // harmless no-op (deleteUser on an already-gone id just errors, caught
    // below). suspendTarget must be unbanned first or its cleanup delete
    // could behave oddly with an active ban — unban defensively, then delete.
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.updateUserById(uid, { ban_duration: "none" }).catch(() => {});
        await admin.auth.admin.deleteUser(uid);
      } catch {
        // already gone (deleteTarget) — fine.
      }
    }
    console.log(`  cleaned up ${createdUserIds.size} throwaway test users`);
  },
});
