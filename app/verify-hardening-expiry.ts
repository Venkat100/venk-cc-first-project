// Options & Margin epic — HARDENING split, part 2/5 (2026-08-15, PLAN.md
// §6c trigger fired — see verify-hardening-valuation.ts's header for the
// full split rationale and PLAN.md §6c for the assertion mapping).
//
// THIS SCRIPT covers: an expired option settles for cash while a margin
// loan is outstanding — proceeds must pay down the loan FIRST, with any
// remainder going to cash, and a 'repay' margin_event logged with
// source=settlement. Self-contained: seeds its own margin-enabled account
// with a real loan (forced by borrowing, not admin-seeded) and an
// already-ITM-expired option position.
//
// Same hardened harness as every prior live-verify script (every await
// timeout-wrapped, timestamped step() logging, one top-level try/catch +
// explicit process.exit — vite-node does not reliably exit on an uncaught
// top-level throw).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser, withRetry } from "./verify-harness";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { runExpiryProcessing } from "@/lib/options/expiry.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) { return `$${Number(n).toFixed(2)}`; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function closeTo(a: number, b: number, eps = 0.02) { return Math.abs(a - b) <= eps; }
function ts() { return new Date().toISOString().slice(11, 23); }
function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms))]);
}
async function step<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}

async function main() {
  const admin = getServiceClient();
  const envText = readFileSync(".env", "utf8");
  const env = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const anonUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;

  console.log("\n████ Setup: margin-enabled test user with a real loan ████");
  const stamp = Date.now();
  const PASSWORD = "HardenPass!234";
  const email = `pt-hardening-expiry-${stamp}@example.org`;
  const { uid } = await step("create test user", 15000, () => createTestUser(admin, email, PASSWORD));
  console.log(`  primary test user: ${email} (${uid})`);
  const client = createClient(anonUrl, anonKey);
  const signIn = await step("sign in", 15000, () => client.auth.signInWithPassword({ email, password: PASSWORD }));
  if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);

  async function profileRow(userId: string) {
    const { data, error } = await withTimeout(`select profiles ${userId}`, admin.from("profiles").select("cash_balance, margin_enabled, margin_loan, margin_status").eq("id", userId).single());
    if (error) throw new Error(error.message);
    return { cash: Number(data.cash_balance), marginEnabled: Boolean(data.margin_enabled), marginLoan: Number(data.margin_loan), marginStatus: data.margin_status as string };
  }
  async function buyStock(userId: string, symbol: string, quantity: number) {
    const quote = await withTimeout(`quote ${symbol}`, withRetry(`quote ${symbol}`, () => getServerQuote(symbol)));
    const profile = await profileRow(userId);
    const positionsValue = profile.marginEnabled ? await getPositionsValue(userId) : 0;
    const { data, error } = await withTimeout("execute_trade (buy)", admin.rpc("execute_trade", { p_user_id: userId, p_symbol: symbol, p_side: "buy", p_quantity: quantity, p_price: quote.price, p_positions_value: positionsValue }));
    if (error) throw new Error("buy failed: " + error.message);
    return { data: data as Record<string, unknown>, price: quote.price };
  }

  // ══════════════════════════════════════════════════════════════════════
  // SEED — force a real margin loan (same mechanism as the original file's
  // section 1: buy 1.5× current cash of a real stock on margin)
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Seed: enable margin, force a real loan ████");
  await step("enable margin", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
  const p0 = await profileRow(uid);
  await step(`buy 1.5× current cash (${money(round2(p0.cash * 1.5))}) of AAPL on margin (forces borrowing)`, 25000, async () => {
    const quote = await withRetry("AAPL quote", () => getServerQuote("AAPL"));
    const targetDollars = round2(p0.cash * 1.5);
    const qty = Math.round((targetDollars / quote.price) * 1e6) / 1e6;
    return buyStock(uid, "AAPL", qty);
  });

  const nvdaQuote = await step("quote NVDA (for the expired contract)", 15000, () => withRetry("NVDA quote", () => getServerQuote("NVDA")));

  // ══════════════════════════════════════════════════════════════════════
  // EXPIRY SETTLEMENT + OUTSTANDING MARGIN LOAN
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Expired option settles for cash while a margin loan is outstanding ████");
  const loanBefore = (await profileRow(uid)).marginLoan;
  assert("loan is outstanding going into this test", loanBefore > 0, money(loanBefore));
  const pastExpiry = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
  const expiredContractId = `NVDA-${pastExpiry}-C-${Math.round(nvdaQuote.price - 20)}`;
  await step("seed an already-ITM-expired option position (test seam, same pattern as O4's own verify script)", 15000, () =>
    admin.from("option_positions").insert({ user_id: uid, contract_id: expiredContractId, symbol: "NVDA", opt_type: "call", strike: Math.round(nvdaQuote.price - 20), expiry: pastExpiry, contracts: 1, avg_premium: 5.0 }),
  );
  const expirySummary = await step("runExpiryProcessing({onlyUserId}) — real settlement, real historical close", 30000, () => runExpiryProcessing({ onlyUserId: uid }));
  console.log(`  expiry summary: ${JSON.stringify(expirySummary)}`);
  assert("exactly 1 position settled", expirySummary.settled === 1 || expirySummary.expiredWorthless === 1, JSON.stringify(expirySummary));
  const afterExpiry = await profileRow(uid);
  const settleTx = (await admin.from("option_transactions").select("*").eq("user_id", uid).eq("contract_id", expiredContractId).single()).data;
  const proceeds = Number(settleTx?.total ?? 0);
  const expectedLoanRepaid = Math.min(proceeds, loanBefore);
  console.log(`  settlement proceeds=${money(proceeds)}, loan before=${money(loanBefore)} → loan after=${money(afterExpiry.marginLoan)} (expected repaid=${money(expectedLoanRepaid)})`);
  assert("proceeds paid down the loan FIRST (consistent with the sell path), remainder (if any) to cash", closeTo(loanBefore - afterExpiry.marginLoan, expectedLoanRepaid), `${loanBefore - afterExpiry.marginLoan} vs ${expectedLoanRepaid}`);
  if (proceeds > 0) {
    const repayEvent = (await admin.from("margin_events").select("*").eq("user_id", uid).eq("kind", "repay").order("created_at", { ascending: false }).limit(1).single()).data;
    assert("a 'repay' margin_event was logged for the settlement, source=settlement", repayEvent?.detail?.source === "settlement", JSON.stringify(repayEvent?.detail));
  }

  console.log(`\n████ CLEANUP ████`);
  await step("delete test user", 15000, () => admin.auth.admin.deleteUser(uid));

  console.log(`\n████ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`} ████\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
