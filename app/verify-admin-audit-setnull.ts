// Verifies migration 0027_admin_audit_log_set_null.sql end-to-end against
// the REAL applied schema — real Supabase, zero mocks. Two things must be
// simultaneously true:
//   1. Deleting an account that has admin_audit_log rows now works, and
//      leaves ZERO rows for its user id anywhere in the schema except
//      admin_audit_log.
//   2. Its audit_log rows SURVIVE the delete — admin_id goes null (proving
//      SET NULL fired, not CASCADE, not a silent FK failure) while
//      admin_email stays exactly what it was (proving the human-readable
//      record is durable, not derived at read time from a row that's now
//      gone).
// Then proves the log is still immutable: a direct service-role UPDATE and
// a direct service-role DELETE against admin_audit_log must both be
// rejected (no grant exists for either, unchanged by 0027), with the row
// confirmed byte-identical after each attempt.
//
// SELF-SEEDING (2026-08-14 hygiene follow-up): the original version of this
// script targeted one specific, hardcoded throwaway-admin UID left over
// from step 10's browser verification — a real regression test the moment
// it was written, but a permanently-red one forever after, since that
// account got consumed by its own first run. Rewritten to create its own
// throwaway user and seed its own admin_audit_log rows, so it's a real,
// repeatable regression test again.
//
// Seeding does NOT require actually granting is_admin (which has no write
// path at all, by design — see 0026_admin_console.sql's threat-model
// comment, and the failed 42501-permission-denied attempt documented in
// the 2026-08-13 fix-pass HANDOFF entry). It only requires a row that
// FK-references the throwaway user as admin_id, which service_role can
// insert DIRECTLY — `grant select, insert on admin_audit_log to
// service_role` (0026) bypasses the admin_log_action/admin_set_suspended
// RPCs' own internal is_admin re-check entirely, since this is a raw table
// write, not a call through either RPC. What's under test here is the FK's
// ON DELETE behavior, not RPC authorization (that's covered separately by
// verify-admin-live.ts's real-RPC-rejection checks).
import { getServiceClient } from "@/lib/supabase/admin.server";
import { step, assert, withTimeout, createTestUser, runVerification } from "./verify-harness";

// Same CASCADE list used by verify-delete-cascade-v2.ts, re-derived here
// (not copy-pasted stale) via the same method its header documents:
//   grep -n "references auth.users" supabase/migrations/*.sql
// as of migrations 0001–0027. `insights` is included even though its
// user_id is nullable for kind='stock' rows (those aren't this user's).
// journal_entries is DELIBERATELY EXCLUDED: it has no service_role grant at
// all (step 6's hard privacy constraint — see 0023_journal.sql), so a
// service-role SELECT against it isn't "0 rows," it's a rejected query.
// That's proven separately (verify-admin-live.ts's journal-privacy checks);
// this throwaway account never trades or journals, so nothing about its
// cleanup depends on being able to read that table.
const CASCADE_TABLES = [
  "profiles", "holdings", "transactions", "watchlist", "portfolio_snapshots",
  "agent_config", "agent_holdings", "agent_transactions", "agent_decisions",
  "agent_snapshots", "agent_proposals", "option_positions", "option_transactions",
  "insights", "account_events", "margin_events", "rate_limit_events",
  "scenario_runs", "scenario_holdings", "scenario_transactions",
] as const;
const USER_COLUMN: Record<string, string> = { profiles: "id" };

const admin = getServiceClient();

async function countForUser(table: string, userId: string): Promise<number> {
  const col = USER_COLUMN[table] ?? "user_id";
  const { count, error } = await admin.from(table).select(col, { count: "exact", head: true }).eq(col, userId);
  if (error) throw new Error(`count(${table}) failed: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log("\n████ 0. Seed: create a throwaway user, give it its own admin_audit_log rows ████");
  const stamp = Date.now();
  const email = `pt-audit-setnull-${stamp}@example.org`;
  const { uid } = await step(`create throwaway user ${email}`, () => createTestUser(admin, email, "AuditSetNullVerify1234!"));

  const seedActions = ["view_user", "suspend_user"] as const;
  const seedInsert = await step("seed 2 admin_audit_log rows referencing this user as admin_id (direct service_role insert, not through the RPCs)", () =>
    admin
      .from("admin_audit_log")
      .insert(seedActions.map((action) => ({ admin_id: uid, admin_email: email, action, target_user_id: null, target_email: null, detail: { seeded_by: "verify-admin-audit-setnull.ts" } })))
      .select("id, action, admin_email, admin_id"),
  );
  if (seedInsert.error) throw new Error(`seed insert failed: ${seedInsert.error.message}`);
  const seededRows = seedInsert.data ?? [];
  assert("seeded exactly 2 admin_audit_log rows", seededRows.length === 2, String(seededRows.length));

  console.log("\n████ 1. Snapshot state BEFORE delete ████");
  const preCascadeCounts: Record<string, number> = {};
  for (const t of CASCADE_TABLES) preCascadeCounts[t] = await countForUser(t, uid);
  console.log("  pre-delete cascade-table counts:", JSON.stringify(preCascadeCounts));
  assert("profiles has exactly 1 row for the target pre-delete", preCascadeCounts.profiles === 1, String(preCascadeCounts.profiles));

  const preAudit = await step("select admin_audit_log where admin_id = target", () =>
    admin.from("admin_audit_log").select("id, action, admin_email, admin_id").eq("admin_id", uid).order("created_at", { ascending: true }));
  if (preAudit.error) throw new Error(`preAudit select failed: ${preAudit.error.message}`);
  const preAuditRows = preAudit.data ?? [];
  assert("target has exactly the 2 seeded audit_log rows before delete", preAuditRows.length === 2, `${preAuditRows.length} rows`);
  console.log(`  pre-delete audit rows for this user: ${preAuditRows.length} — actions: ${preAuditRows.map((r) => r.action).join(", ")}`);
  const preAuditIds = preAuditRows.map((r) => r.id as string);

  console.log("\n████ 2. Delete the account for real ████");
  const del = await step("auth.admin.deleteUser(uid)", () => withTimeout("deleteUser", admin.auth.admin.deleteUser(uid), 20000));
  assert("delete call succeeded", !del.error, del.error?.message ?? "");

  console.log("\n████ 3. Confirm the account is genuinely gone ████");
  const after = await step("getUserById(uid) post-delete", () => withTimeout("getUserById post", admin.auth.admin.getUserById(uid), 15000));
  assert("account no longer resolvable by id", !after.data.user, after.data.user ? "still exists" : "gone");

  console.log("\n████ 4. Confirm ZERO rows remain anywhere EXCEPT admin_audit_log ████");
  for (const t of CASCADE_TABLES) {
    const n = await countForUser(t, uid);
    assert(`${t}: 0 rows post-delete`, n === 0, `${n} rows`);
  }

  console.log("\n████ 5. Confirm the audit_log rows SURVIVED, with admin_id null and admin_email intact ████");
  const postAudit = await step("select admin_audit_log by the SAME captured ids (admin_id is gone now, can't filter by it)", () =>
    admin.from("admin_audit_log").select("id, action, admin_email, admin_id").in("id", preAuditIds));
  if (postAudit.error) throw new Error(`postAudit select failed: ${postAudit.error.message}`);
  const postAuditRows = postAudit.data ?? [];
  assert("exact same NUMBER of audit rows survive (none dropped, none duplicated)", postAuditRows.length === preAuditRows.length, `${postAuditRows.length} vs ${preAuditRows.length}`);
  const allNull = postAuditRows.every((r) => r.admin_id === null);
  assert("every surviving row's admin_id is now null (SET NULL fired, not silently left stale)", allNull, JSON.stringify(postAuditRows.map((r) => r.admin_id)));
  const allEmailIntact = postAuditRows.every((r) => r.admin_email === email);
  assert("every surviving row's admin_email is UNCHANGED, still readable, still the deleted account's real email", allEmailIntact, JSON.stringify(postAuditRows.map((r) => r.admin_email)));
  const actionsMatch = JSON.stringify(preAuditRows.map((r) => r.action).sort()) === JSON.stringify(postAuditRows.map((r) => r.action).sort());
  assert("the SET of actions recorded is byte-identical before/after (no content silently altered)", actionsMatch);

  console.log("\n████ 6. Immutability: a direct service-role UPDATE against admin_audit_log must be rejected ████");
  const sampleId = preAuditIds[0];
  const preTamperRead = await admin.from("admin_audit_log").select("action").eq("id", sampleId).single();
  if (preTamperRead.error) throw new Error(`preTamperRead failed: ${preTamperRead.error.message}`);
  const originalAction = preTamperRead.data.action;

  const updateAttempt = await step("service_role UPDATE admin_audit_log (should be rejected — no update grant exists)", () =>
    admin.from("admin_audit_log").update({ action: "TAMPERED_BY_VERIFY_SCRIPT" }).eq("id", sampleId));
  assert("UPDATE was rejected with an error", !!updateAttempt.error, updateAttempt.error?.message ?? "NO ERROR — THIS IS A REAL PROBLEM");
  if (updateAttempt.error) console.log(`  update rejection (expected, proves no UPDATE grant): ${updateAttempt.error.message}`);

  const postUpdateRead = await admin.from("admin_audit_log").select("action").eq("id", sampleId).single();
  assert("row's action field is byte-identical after the rejected UPDATE attempt", postUpdateRead.data?.action === originalAction, postUpdateRead.data?.action);

  console.log("\n████ 7. Immutability: a direct service-role DELETE against admin_audit_log must be rejected ████");
  const deleteAttempt = await step("service_role DELETE admin_audit_log row (should be rejected — no delete grant exists)", () =>
    admin.from("admin_audit_log").delete().eq("id", sampleId));
  assert("DELETE was rejected with an error", !!deleteAttempt.error, deleteAttempt.error?.message ?? "NO ERROR — THIS IS A REAL PROBLEM");
  if (deleteAttempt.error) console.log(`  delete rejection (expected, proves no DELETE grant): ${deleteAttempt.error.message}`);

  const postDeleteRead = await admin.from("admin_audit_log").select("id, action").eq("id", sampleId).maybeSingle();
  assert("row still exists after the rejected DELETE attempt", !!postDeleteRead.data, postDeleteRead.data ? "present" : "GONE — data loss");
  assert("row's action field is STILL byte-identical after both rejected attempts", postDeleteRead.data?.action === originalAction, postDeleteRead.data?.action);

  console.log("\n████ RESULT ████");
  console.log(`  NOTE: this run's 2 orphaned admin_audit_log rows (admin_id=null, admin_email=${email}) are intentionally NOT cleaned up —`);
  console.log("  there is no delete grant on this table for ANY role, by design (immutability). This is not test pollution: it's the exact");
  console.log("  same trace a real admin's audit history leaves behind if that admin account is later deleted. Re-running this script adds");
  console.log("  2 more such rows under a fresh timestamped email, same as it would in production for repeated real admin+delete cycles.");
}

runVerification(main);
