// M2 browser-verification helper — NOT the M1 engine test (that's
// verify-margin-live.ts, already complete and untouched). This script only
// creates/inspects/force-seeds state so I can drive the actual UI
// (app.margin.tsx + ConfirmDialogs) through the browser and read the DB
// back to confirm the UI matches it to the cent. Same hardened harness
// (timeouts, step() logging, explicit process.exit()) as every other
// live-verify script in this repo, for the same vite-node-hang reason.
//
// Moved from verify-margin-ui.ts to tools/margin-ui.ts (2026-08-14 hygiene
// follow-up): this is an argv-driven CLI ops helper (create|state|force|
// monitor|delete), not a self-checking test — it always "failed" when swept
// up bare by the verify-*.ts glob, which every prior regression-suite run
// had to individually footnote as a non-failure. Living outside that glob
// means the full suite can now be 100% green with zero asterisks. Usage
// unchanged: `npx vite-node tools/margin-ui.ts <create|state|force|monitor|delete> [...]`.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { MARGIN_MAINTENANCE_PCT, MARGIN_WARNING_BUFFER_PCT } from "@/lib/margin/config.server";
import { createTestUser } from "../verify-harness";

function ts() { return new Date().toISOString().slice(11, 23); }
function withTimeout<T>(label: string, p: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms))]);
}
async function step<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}
function round2(n: number) { return Math.round(n * 100) / 100; }

async function main() {
  const admin = getServiceClient();
  const cmd = process.argv[2];

  if (cmd === "create") {
    const envText = readFileSync(".env", "utf8");
    const env = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    const stamp = Date.now();
    const PASSWORD = "M2VerifyPass!234";
    const email = `pt-m2-verify-${stamp}@example.org`;
    const { uid } = await step("create test user", 15000, () => createTestUser(admin, email, PASSWORD));
    console.log(`\nEMAIL=${email}\nPASSWORD=${PASSWORD}\nUID=${uid}\nANON_URL=${env.VITE_SUPABASE_URL}\n`);
    return;
  }

  if (cmd === "state") {
    const uid = process.argv[3];
    const profile = await step("read profile", 15000, () => admin.from("profiles").select("cash_balance, margin_enabled, margin_loan, margin_status").eq("id", uid).single());
    if (profile.error) throw new Error(profile.error.message);
    const cash = Number(profile.data.cash_balance);
    const loan = Number(profile.data.margin_loan);
    const positionsValue = await step("getPositionsValue", 20000, () => getPositionsValue(uid!));
    const equity = round2(cash + positionsValue - loan);
    const maintenanceReq = round2(positionsValue * MARGIN_MAINTENANCE_PCT);
    console.log(JSON.stringify({ cash, marginEnabled: profile.data.margin_enabled, marginLoan: loan, marginStatus: profile.data.margin_status, positionsValue, equity, maintenanceReq, warningCeiling: round2(maintenanceReq * (1 + MARGIN_WARNING_BUFFER_PCT)) }, null, 2));
    return;
  }

  if (cmd === "force") {
    // force <uid> <targetEquityMultipleOfMaintenance>  e.g. 1.05 (inside warning band), 0.5 (a real call)
    const uid = process.argv[3];
    const mult = Number(process.argv[4]);
    const profile = await step("read profile", 15000, () => admin.from("profiles").select("cash_balance").eq("id", uid).single());
    if (profile.error) throw new Error(profile.error.message);
    const cash = Number(profile.data.cash_balance);
    const positionsValue = await step("getPositionsValue", 20000, () => getPositionsValue(uid!));
    const maintenanceReq = round2(positionsValue * MARGIN_MAINTENANCE_PCT);
    const targetEquity = round2(maintenanceReq * mult);
    // equity = cash + positionsValue - loan  =>  loan = cash + positionsValue - equity
    const forcedLoan = round2(cash + positionsValue - targetEquity);
    const seeded = await step("admin_seed_margin_state RPC", 15000, () => admin.rpc("admin_seed_margin_state", { p_user_id: uid, p_margin_loan: forcedLoan, p_last_interest_accrued_at: null }));
    if (seeded.error) throw new Error("seed failed: " + seeded.error.message);
    console.log(`  forced margin_loan → $${forcedLoan.toFixed(2)} (positionsValue=$${positionsValue.toFixed(2)}, maintenanceReq=$${maintenanceReq.toFixed(2)}, targetEquity=$${targetEquity.toFixed(2)})`);
    return;
  }

  if (cmd === "setloan") {
    // setloan <uid> <exact amount> — direct override via the same sanctioned
    // admin_seed_margin_state seam (0013), used here only to compose a
    // "cash > 0 AND loan > 0" state for testing manual repay (structurally
    // impossible to reach through trading alone in one step, since buys
    // spend cash before borrowing and sells auto-repay the loan before
    // cash) without touching real cash — cash comes from a real sell.
    const uid = process.argv[3];
    const amount = Number(process.argv[4]);
    const seeded = await step("admin_seed_margin_state RPC", 15000, () => admin.rpc("admin_seed_margin_state", { p_user_id: uid, p_margin_loan: amount, p_last_interest_accrued_at: null }));
    if (seeded.error) throw new Error("seed failed: " + seeded.error.message);
    console.log(`  set margin_loan → $${amount.toFixed(2)}`);
    return;
  }

  if (cmd === "monitor") {
    const uid = process.argv[3];
    const summary = await step("runMarginMonitor", 30000, () => runMarginMonitor({ onlyUserId: uid }));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (cmd === "delete") {
    const uid = process.argv[3];
    await step("delete test user", 15000, () => admin.auth.admin.deleteUser(uid!));
    console.log("  deleted");
    return;
  }

  throw new Error(`unknown command: ${cmd} (use create|state|force|monitor|delete)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
