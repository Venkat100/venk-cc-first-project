// Options & Margin epic — HARDENING split, part 3/5 (2026-08-15, PLAN.md
// §6c trigger fired — see verify-hardening-valuation.ts's header for the
// full split rationale and PLAN.md §6c for the assertion mapping).
//
// THIS SCRIPT is the recently-flaky scenario, now isolated: a margin call
// where the LARGEST position is an option — the liquidator must be able to
// sell it, not just stocks. Both flakes that triggered this split were a
// STEP TIMEOUT on exactly the runMarginMonitor call below; isolating this
// scenario means a re-run (or a real regression, if one ever appears) is a
// single short script, not 430 lines and 5 other scenarios' worth of
// re-running to get back to the failing step. Self-contained: seeds its own
// margin-enabled account with a modest stock position and a large option
// position, then forces a loan directly via the same admin_seed_margin_state
// seam the original script used (not organic borrowing — the call itself is
// what's under test, not how the loan got there).
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
import { getRealizedVol } from "@/lib/options/volatility.server";
import { buildChain } from "@/lib/options/chain.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { MARGIN_MAINTENANCE_PCT } from "@/lib/margin/config.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) { return `$${Number(n).toFixed(2)}`; }
function round2(n: number) { return Math.round(n * 100) / 100; }
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

  console.log("\n████ Setup: margin-enabled test user, modest stock + large option position ████");
  const stamp = Date.now();
  const PASSWORD = "HardenPass!234";
  const email = `pt-hardening-liquidation-${stamp}@example.org`;
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
  async function tradeOption(userId: string, contractId: string, side: "buy_to_open" | "sell_to_close", contracts: number) {
    const { parseContractId, priceParsedContract } = await import("@/lib/options/chain.server");
    const parsed = parseContractId(contractId)!;
    const [quote, vol] = await Promise.all([withRetry(`quote ${parsed.symbol}`, () => getServerQuote(parsed.symbol)), withRetry(`vol ${parsed.symbol}`, () => getRealizedVol(parsed.symbol))]);
    const priced = priceParsedContract(parsed, quote.price, vol);
    const profile = await profileRow(userId);
    const positionsValue = profile.marginEnabled ? await getPositionsValue(userId) : 0;
    const { data, error } = await withTimeout("execute_option_trade", admin.rpc("execute_option_trade", {
      p_user_id: userId, p_contract_id: contractId, p_symbol: parsed.symbol, p_opt_type: parsed.type, p_strike: parsed.strike, p_expiry: parsed.expiry,
      p_side: side, p_contracts: contracts, p_premium: priced.premium, p_positions_value: positionsValue,
    }));
    if (error) throw new Error("option trade failed: " + error.message);
    return { data: data as Record<string, unknown>, premium: priced.premium };
  }

  // ══════════════════════════════════════════════════════════════════════
  // SEED — a modest stock position + a large option position, margin on
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Seed: enable margin, buy 1 AAPL (modest), buy 5 NVDA calls (the largest candidate) ████");
  await step("enable margin", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
  await step("buy 1 AAPL (modest stock position)", 20000, () => buyStock(uid, "AAPL", 1));

  const [nvdaQuote, nvdaVol] = await step("quote+vol NVDA (for option chain)", 20000, () => Promise.all([withRetry("NVDA quote", () => getServerQuote("NVDA")), withRetry("NVDA vol", () => getRealizedVol("NVDA"))]));
  const chain = buildChain({ symbol: "NVDA", spot: nvdaQuote.price, vol: nvdaVol });
  const expiry = chain.expiries.find((e) => e.daysToExpiry > 0) ?? chain.expiries[0];
  let atmIdx = 0;
  for (let i = 1; i < expiry.strikes.length; i++) if (Math.abs(expiry.strikes[i].strike - nvdaQuote.price) < Math.abs(expiry.strikes[atmIdx].strike - nvdaQuote.price)) atmIdx = i;
  const optionContract = expiry.strikes[atmIdx].call;
  await step("buy 5 NVDA calls (grows the option position to be the largest candidate)", 20000, () => tradeOption(uid, optionContract.contractId, "buy_to_open", 5));

  // ══════════════════════════════════════════════════════════════════════
  // MARGIN CALL LIQUIDATION CAN SELL AN OPTION POSITION
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Force a call where the LARGEST position is the option — liquidator must sell it ████");
  const positionsValue = await step("getPositionsValue (pre-call)", 20000, () => getPositionsValue(uid));
  const maintenanceReq = round2(positionsValue * MARGIN_MAINTENANCE_PCT);
  const targetEquity = round2(maintenanceReq * 0.5); // a genuine call
  const p = await profileRow(uid);
  const forcedLoan = round2(p.cash + positionsValue - targetEquity);
  await step("force loan to trigger a genuine call (admin_seed_margin_state seam)", 15000, () => admin.rpc("admin_seed_margin_state", { p_user_id: uid, p_margin_loan: forcedLoan, p_last_interest_accrued_at: null }));
  const monitorSummary = await step("runMarginMonitor({onlyUserId}) — real liquidation", 30000, () => runMarginMonitor({ onlyUserId: uid }));
  const result = monitorSummary.results[0];
  console.log(`  monitor result: ${JSON.stringify(result)}`);
  assert("a call fired and a liquidation occurred", monitorSummary.calls === 1 && monitorSummary.liquidations === 1, JSON.stringify(monitorSummary));
  const soldKinds = (result?.liquidated ?? []).map((l) => l.kind);
  assert("the liquidator sold an OPTION position (not stocks-only) — an options-heavy account IS rescuable", soldKinds.includes("option"), JSON.stringify(soldKinds));
  console.log(`  sold: ${JSON.stringify(result?.liquidated)}`);

  console.log(`\n████ CLEANUP ████`);
  await step("delete test user", 15000, () => admin.auth.admin.deleteUser(uid));

  console.log(`\n████ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`} ████\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
