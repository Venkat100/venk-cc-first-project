// Verifies migration 0027_admin_audit_log_set_null.sql end-to-end against
// the REAL applied schema — real Supabase, zero mocks. Two things must be
// simultaneously true, and this script proves both against the actual
// throwaway admin account left over from step 10's browser verification
// (banned, not deleted, specifically because the old ON DELETE RESTRICT
// blocked deleting it — see HANDOFF):
//   1. Deleting that account now works, and leaves ZERO rows for its user
//      id anywhere in the schema except admin_audit_log.
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
// Per the standing safety rule: this script only ever acts on the one
// specific throwaway account it's told to act on, gated by an exact-email
// match assertion before the one destructive call — never a pattern that
// could accidentally widen to a real account.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { step, assert, withTimeout, runVerification } from "./verify-harness";

const TARGET_UID = "80e1c0de-2a0b-42a7-a95b-a6ee4b60f680";
const TARGET_EMAIL = "pt-admin-verify-browseradmin-1786571608726@example.org";

// Same CASCADE list used by verify-delete-cascade-v2.ts, re-derived here
// (not copy-pasted stale) via the same method its header documents:
//   grep -n "references auth.users" supabase/migrations/*.sql
// as of migrations 0001–0027. `insights` is included even though its
// user_id is nullable for kind='stock' rows (those aren't this user's).
// journal_entries is DELIBERATELY EXCLUDED: it has no service_role grant at
// all (step 6's hard privacy constraint — see 0023_journal.sql), so a
// service-role SELECT against it isn't "0 rows," it's a rejected query.
// That's proven separately (verify-admin-live.ts's journal-privacy checks);
// this throwaway admin account never traded and never journaled, so
// nothing about its cleanup depends on being able to read that table.
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
  console.log("\n████ 1. Confirm the target is exactly the known throwaway admin, nothing else ████");
  const before = await step("getUserById(TARGET_UID)", () => withTimeout("getUserById", admin.auth.admin.getUserById(TARGET_UID), 15000));
  assert("target account still exists pre-delete", !!before.data.user, before.error?.message ?? "");
  assert("target email matches exactly the known throwaway admin (safety gate)", before.data.user?.email === TARGET_EMAIL, before.data.user?.email);
  if (before.data.user?.email !== TARGET_EMAIL) throw new Error("SAFETY ABORT: target email did not match — refusing to delete");

  console.log("\n████ 2. Snapshot state BEFORE delete ████");
  const preCascadeCounts: Record<string, number> = {};
  for (const t of CASCADE_TABLES) preCascadeCounts[t] = await countForUser(t, TARGET_UID);
  console.log("  pre-delete cascade-table counts:", JSON.stringify(preCascadeCounts));
  assert("profiles has exactly 1 row for the target pre-delete", preCascadeCounts.profiles === 1, String(preCascadeCounts.profiles));

  const preAudit = await step("select admin_audit_log where admin_id = target", () =>
    admin.from("admin_audit_log").select("id, action, admin_email, admin_id").eq("admin_id", TARGET_UID).order("created_at", { ascending: true }));
  if (preAudit.error) throw new Error(`preAudit select failed: ${preAudit.error.message}`);
  const preAuditRows = preAudit.data ?? [];
  assert("target admin has ≥1 audit_log row before delete (it really did act as admin)", preAuditRows.length > 0, `${preAuditRows.length} rows`);
  console.log(`  pre-delete audit rows for this admin: ${preAuditRows.length} — actions: ${preAuditRows.map((r) => r.action).join(", ")}`);
  const preAuditIds = preAuditRows.map((r) => r.id as string);

  console.log("\n████ 3. Delete the account for real ████");
  const del = await step("auth.admin.deleteUser(TARGET_UID)", () => withTimeout("deleteUser", admin.auth.admin.deleteUser(TARGET_UID), 20000));
  assert("delete call succeeded", !del.error, del.error?.message ?? "");

  console.log("\n████ 4. Confirm the account is genuinely gone ████");
  const after = await step("getUserById(TARGET_UID) post-delete", () => withTimeout("getUserById post", admin.auth.admin.getUserById(TARGET_UID), 15000));
  assert("account no longer resolvable by id", !after.data.user, after.data.user ? "still exists" : "gone");

  console.log("\n████ 5. Confirm ZERO rows remain anywhere EXCEPT admin_audit_log ████");
  for (const t of CASCADE_TABLES) {
    const n = await countForUser(t, TARGET_UID);
    assert(`${t}: 0 rows post-delete`, n === 0, `${n} rows`);
  }

  console.log("\n████ 6. Confirm the audit_log rows SURVIVED, with admin_id null and admin_email intact ████");
  const postAudit = await step("select admin_audit_log by the SAME captured ids (admin_id is gone now, can't filter by it)", () =>
    admin.from("admin_audit_log").select("id, action, admin_email, admin_id").in("id", preAuditIds));
  if (postAudit.error) throw new Error(`postAudit select failed: ${postAudit.error.message}`);
  const postAuditRows = postAudit.data ?? [];
  assert("exact same NUMBER of audit rows survive (none dropped, none duplicated)", postAuditRows.length === preAuditRows.length, `${postAuditRows.length} vs ${preAuditRows.length}`);
  const allNull = postAuditRows.every((r) => r.admin_id === null);
  assert("every surviving row's admin_id is now null (SET NULL fired, not silently left stale)", allNull, JSON.stringify(postAuditRows.map((r) => r.admin_id)));
  const allEmailIntact = postAuditRows.every((r) => r.admin_email === TARGET_EMAIL);
  assert("every surviving row's admin_email is UNCHANGED, still readable, still the deleted account's real email", allEmailIntact, JSON.stringify(postAuditRows.map((r) => r.admin_email)));
  const actionsMatch = JSON.stringify(preAuditRows.map((r) => r.action).sort()) === JSON.stringify(postAuditRows.map((r) => r.action).sort());
  assert("the SET of actions recorded is byte-identical before/after (no content silently altered)", actionsMatch);

  console.log("\n████ 7. Immutability: a direct service-role UPDATE against admin_audit_log must be rejected ████");
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

  console.log("\n████ 8. Immutability: a direct service-role DELETE against admin_audit_log must be rejected ████");
  const deleteAttempt = await step("service_role DELETE admin_audit_log row (should be rejected — no delete grant exists)", () =>
    admin.from("admin_audit_log").delete().eq("id", sampleId));
  assert("DELETE was rejected with an error", !!deleteAttempt.error, deleteAttempt.error?.message ?? "NO ERROR — THIS IS A REAL PROBLEM");
  if (deleteAttempt.error) console.log(`  delete rejection (expected, proves no DELETE grant): ${deleteAttempt.error.message}`);

  const postDeleteRead = await admin.from("admin_audit_log").select("id, action").eq("id", sampleId).maybeSingle();
  assert("row still exists after the rejected DELETE attempt", !!postDeleteRead.data, postDeleteRead.data ? "present" : "GONE — data loss");
  assert("row's action field is STILL byte-identical after both rejected attempts", postDeleteRead.data?.action === originalAction, postDeleteRead.data?.action);

  console.log("\n████ RESULT ████");
}

runVerification(main);
