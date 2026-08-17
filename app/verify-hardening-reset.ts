// Options & Margin epic — HARDENING split, part 5/5 (2026-08-15, PLAN.md
// §6c trigger fired — see verify-hardening-valuation.ts's header for the
// full split rationale and PLAN.md §6c for the assertion mapping).
//
// THIS SCRIPT covers: reset with stocks + options + margin loan + an active
// agent ALL simultaneously active — the reset RPC must wipe every one of
// those surfaces, KEEP the ledgers (margin_events, option_transactions),
// and leave the account in a state where Dashboard/Margin/snapshot still
// agree (all zero-ish now, proving the 4-way-reconciliation fix doesn't
// misbehave at loan=0). Self-contained: seeds its own account with all
// four surfaces active before resetting.
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
import { buildChain, parseContractId, priceParsedContract } from "@/lib/options/chain.server";
import { STARTING_CASH } from "@/lib/mockData";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { runSnapshots } from "@/lib/snapshots/writer.server";

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

  console.log("\n████ Setup: test user with stocks + options + margin loan + active agent ████");
  const stamp = Date.now();
  const PASSWORD = "HardenPass!234";
  const email = `pt-hardening-reset-${stamp}@example.org`;
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
  // SEED — stocks + margin loan + option + funded, actually-traded agent
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Seed: stock + margin loan + option + funded agent, all four surfaces active ████");
  await step("buy 1 AAPL", 20000, () => buyStock(uid, "AAPL", 1));
  await step("upsert agent_config (enabled, balanced, autonomous)", 15000, () => admin.from("agent_config").upsert({ user_id: uid, enabled: true, mode: "autonomous", risk_level: "balanced" }, { onConflict: "user_id" }));
  const fund1 = await step("fund_agent $10,000", 15000, () => admin.rpc("fund_agent", { p_user_id: uid, p_amount: 10000 }));
  assert("fund_agent succeeded", !fund1.error, fund1.error?.message);
  await step("enable margin", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
  const p0 = await profileRow(uid);
  await step(`buy 1.5× current cash (${money(round2(p0.cash * 1.5))}) more AAPL (forces a loan)`, 25000, async () => {
    const quote = await withRetry("AAPL quote", () => getServerQuote("AAPL"));
    const targetDollars = round2(p0.cash * 1.5);
    const qty = Math.round((targetDollars / quote.price) * 1e6) / 1e6;
    return buyStock(uid, "AAPL", qty);
  });
  const [nvdaQuote, nvdaVol] = await step("quote+vol NVDA (for option chain)", 20000, () => Promise.all([withRetry("NVDA quote", () => getServerQuote("NVDA")), withRetry("NVDA vol", () => getRealizedVol("NVDA"))]));
  const chain = buildChain({ symbol: "NVDA", spot: nvdaQuote.price, vol: nvdaVol });
  const expiry = chain.expiries.find((e) => e.daysToExpiry > 0) ?? chain.expiries[0];
  let atmIdx = 0;
  for (let i = 1; i < expiry.strikes.length; i++) if (Math.abs(expiry.strikes[i].strike - nvdaQuote.price) < Math.abs(expiry.strikes[atmIdx].strike - nvdaQuote.price)) atmIdx = i;
  const optionContract = expiry.strikes[atmIdx].call;
  await step("buy 1 NVDA call", 20000, () => tradeOption(uid, optionContract.contractId, "buy_to_open", 1));
  const { runThinker } = await import("@/lib/agent/thinker.server");
  const thinkerResult = await step("run real thinker (AI disabled, quant only)", 120000, () => runThinker(uid, { disableAi: true }));
  console.log(`  thinker: ran=${thinkerResult.ran} trades=${thinkerResult.executed?.length ?? 0}`);

  // ══════════════════════════════════════════════════════════════════════
  // RESET WITH EVERYTHING ACTIVE (options + margin + agent)
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Reset with stocks + options + margin loan + active agent ALL simultaneously active ████");
  const before = await profileRow(uid);
  const { data: holdingsBefore } = await admin.from("holdings").select("*").eq("user_id", uid);
  const { data: optPosBefore } = await admin.from("option_positions").select("*").eq("user_id", uid);
  const { data: agentHoldBefore } = await admin.from("agent_holdings").select("*").eq("user_id", uid);
  console.log(`  pre-reset: cash=${money(before.cash)} loan=${money(before.marginLoan)} holdings=${(holdingsBefore ?? []).length} options=${(optPosBefore ?? []).length} agentHoldings=${(agentHoldBefore ?? []).length}`);
  assert("account genuinely has stocks+options+margin loan+agent holdings before reset", (holdingsBefore ?? []).length > 0 && (optPosBefore ?? []).length > 0 && before.marginLoan > 0 && (agentHoldBefore ?? []).length > 0);

  const { data: rpcResult, error: resetErr } = await step("reset_paper_account RPC", 15000, () => admin.rpc("reset_paper_account", { p_user_id: uid }));
  assert("reset RPC succeeded", !resetErr, resetErr?.message);
  console.log(`  reset returned: ${JSON.stringify(rpcResult)}`);

  const after = await profileRow(uid);
  // Reset targets the CURRENT default (STARTING_CASH), never a hardcoded
  // figure, per 0016_starting_capital.sql's own design.
  assert(`cash reset to exactly the current default ${money(STARTING_CASH)}`, after.cash === STARTING_CASH, money(after.cash));
  assert("margin fully reset (disabled, 0 loan, ok status)", !after.marginEnabled && after.marginLoan === 0 && after.marginStatus === "ok", JSON.stringify(after));
  const { data: holdingsAfter } = await admin.from("holdings").select("*").eq("user_id", uid);
  const { data: optPosAfter } = await admin.from("option_positions").select("*").eq("user_id", uid);
  const { data: agentHoldAfter } = await admin.from("agent_holdings").select("*").eq("user_id", uid);
  const { data: agentCfgAfter } = await admin.from("agent_config").select("*").eq("user_id", uid).single();
  assert("holdings cleared", (holdingsAfter ?? []).length === 0, `${(holdingsAfter ?? []).length}`);
  assert("option_positions cleared", (optPosAfter ?? []).length === 0, `${(optPosAfter ?? []).length}`);
  assert("agent_holdings cleared", (agentHoldAfter ?? []).length === 0, `${(agentHoldAfter ?? []).length}`);
  assert("agent_config reset to defaults (disabled, 0 cash)", agentCfgAfter?.enabled === false && Number(agentCfgAfter?.agent_cash) === 0, JSON.stringify(agentCfgAfter));
  const marginEvents = await admin.from("margin_events").select("id").eq("user_id", uid);
  const optTx = await admin.from("option_transactions").select("id").eq("user_id", uid);
  assert("ledgers KEPT (margin_events, option_transactions still present, not wiped)", (marginEvents.data ?? []).length > 0 && (optTx.data ?? []).length > 0, `margin_events=${marginEvents.data?.length}, option_tx=${optTx.data?.length}`);
  const accountEvents = await admin.from("account_events").select("*").eq("user_id", uid).eq("kind", "reset");
  assert("exactly one 'reset' account_events marker", (accountEvents.data ?? []).length === 1, `${accountEvents.data?.length}`);

  // Post-reset reconciliation: Dashboard/Margin/snapshot must still agree
  // (all zero-ish now) — the 4-way-reconciliation fix shouldn't misbehave at loan=0.
  await step("runSnapshots post-reset", 20000, () => runSnapshots({ onlyUserId: uid }));
  const today = new Date().toISOString().slice(0, 10);
  const { data: postSnapRow } = await admin.from("portfolio_snapshots").select("total_value").eq("user_id", uid).eq("captured_at", today).single();
  assert(`post-reset snapshot total_value === the current default ${money(STARTING_CASH)} exactly (loan=0, so the fix is a no-op here)`, Number(postSnapRow?.total_value) === STARTING_CASH, `${postSnapRow?.total_value}`);

  console.log(`\n████ CLEANUP ████`);
  await step("delete test user", 15000, () => admin.auth.admin.deleteUser(uid));

  console.log(`\n████ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`} ████\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
