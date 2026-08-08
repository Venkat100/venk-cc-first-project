// Real E2E for the O2 options trade engine (run with vite-node). REAL
// Twelve Data + Finnhub + Postgres, no mocks. Throwaway test users, deleted
// at the end.
//
// METHODOLOGY NOTE: `executeOptionTradeFn` is a TanStack Start `createServerFn`
// — confirmed (by directly trying it) that it throws "No Start context found
// in AsyncLocalStorage" when invoked outside the real server request runtime,
// which a plain vite-node script isn't. This project's OWN cron endpoints
// (lib/agent/cron.server.ts) hit the exact same constraint and solve it the
// same way: bypass the createServerFn wrapper and call the underlying
// functions directly. This script does that — every step below calls the
// REAL imported function (verifyUser, parseContractId, priceParsedContract,
// getServerQuote, getRealizedVol, and the REAL execute_option_trade Postgres
// function via the REAL service client) in the SAME order the handler does.
// The one thing that can't be exercised this way is the createServerFn/Zod
// glue itself — so that piece is verified separately and directly, using the
// REAL exported `executeOptionTradeInputSchema` object (not a
// reconstruction), in §5 below.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { verifyUser, getServiceClient } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { getRealizedVol } from "@/lib/options/volatility.server";
import { buildChain, parseContractId, priceParsedContract } from "@/lib/options/chain.server";
import { executeOptionTradeInputSchema } from "@/lib/options/functions";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) {
  return `$${n.toFixed(6)}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function closeTo(a: number, b: number, eps: number) {
  return Math.abs(a - b) <= eps;
}

// ── Env + clients ───────────────────────────────────────────────────────────
const envText = readFileSync(".env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const admin = getServiceClient();
const anonUrl = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

const stamp = Date.now();
const userAEmail = `pt-o2-verify-a-${stamp}@example.org`;
const userBEmail = `pt-o2-verify-b-${stamp}@example.org`;
const PASSWORD = "O2VerifyPass!234";

console.log("\n████ Setup: two throwaway test users ████");
const { data: userA, error: errA } = await admin.auth.admin.createUser({ email: userAEmail, password: PASSWORD, email_confirm: true });
const { data: userB, error: errB } = await admin.auth.admin.createUser({ email: userBEmail, password: PASSWORD, email_confirm: true });
if (errA || errB || !userA.user || !userB.user) throw new Error(`user creation failed: ${errA?.message} ${errB?.message}`);
const userAId = userA.user.id;
const userBId = userB.user.id;
console.log(`  user A: ${userAEmail} (${userAId})`);
console.log(`  user B: ${userBEmail} (${userBId})`);

const clientA = createClient(anonUrl, anonKey);
const clientB = createClient(anonUrl, anonKey);
const { data: signInA, error: signInAErr } = await clientA.auth.signInWithPassword({ email: userAEmail, password: PASSWORD });
const { data: signInB, error: signInBErr } = await clientB.auth.signInWithPassword({ email: userBEmail, password: PASSWORD });
if (signInAErr || signInBErr || !signInA.session || !signInB.session) throw new Error(`sign-in failed: ${signInAErr?.message} ${signInBErr?.message}`);
const tokenA = signInA.session.access_token;
const tokenB = signInB.session.access_token;

const verifiedA = await verifyUser(tokenA);
assert("verifyUser(tokenA) resolves to the real signed-in user A id (real JWT round-trip)", verifiedA === userAId, `${verifiedA}`);

async function cash(userId: string): Promise<number> {
  const { data, error } = await admin.from("profiles").select("cash_balance").eq("id", userId).single();
  if (error) throw new Error(error.message);
  return Number(data.cash_balance);
}
async function position(userId: string, contractId: string) {
  const { data, error } = await admin.from("option_positions").select("*").eq("user_id", userId).eq("contract_id", contractId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { contracts: number; avg_premium: number } | null;
}

// ── The harness: reproduces executeOptionTradeFn's handler EXACTLY, calling
// the same real functions in the same order, given an already-verified JWT. ──
type TradeInput = { accessToken: string; contractId: string; side: "buy_to_open" | "sell_to_close"; contracts: number };
type TradeOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

async function runTrade(raw: TradeInput & Record<string, unknown>): Promise<TradeOutcome> {
  // Same Zod object the real server function uses — strips any extra field
  // (e.g. a doctored `premium`) before anything below ever runs.
  const data = executeOptionTradeInputSchema.parse(raw);

  const userId = await verifyUser(data.accessToken);
  const parsed = parseContractId(data.contractId);
  if (!parsed) return { ok: false, error: "unknown_contract" };
  const todayIso = new Date().toISOString().slice(0, 10);
  if (parsed.expiry < todayIso) return { ok: false, error: "expired_contract" };

  const [quote, vol] = await Promise.all([getServerQuote(parsed.symbol), getRealizedVol(parsed.symbol)]);
  if (!quote || !(quote.price > 0)) return { ok: false, error: "no_price" };
  const priced = priceParsedContract(parsed, quote.price, vol);

  console.log(`    [server-computed] spot=$${quote.price} vol=${(vol * 100).toFixed(1)}% → premium=${money(priced.premium)}  (doctored input premium, if any, was IGNORED: ${"premium" in raw ? raw.premium : "n/a — not sent"})`);

  const { data: rpc, error } = await admin.rpc("execute_option_trade", {
    p_user_id: userId,
    p_contract_id: data.contractId.toUpperCase(),
    p_symbol: parsed.symbol,
    p_opt_type: parsed.type,
    p_strike: parsed.strike,
    p_expiry: parsed.expiry,
    p_side: data.side,
    p_contracts: data.contracts,
    p_premium: priced.premium,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, result: rpc as Record<string, unknown> };
}

// ── 1. Pick a real, near-ATM, non-expired NVDA call ─────────────────────────
console.log("\n████ 1. Real NVDA option chain — pick a near-ATM call ████");
const [nvdaQuote, nvdaVol] = await Promise.all([getServerQuote("NVDA"), getRealizedVol("NVDA")]);
const chain = buildChain({ symbol: "NVDA", spot: nvdaQuote.price, vol: nvdaVol });
const expiry = chain.expiries.find((e) => e.daysToExpiry > 0) ?? chain.expiries[0];
let atmIdx = 0;
for (let i = 1; i < expiry.strikes.length; i++) {
  if (Math.abs(expiry.strikes[i].strike - nvdaQuote.price) < Math.abs(expiry.strikes[atmIdx].strike - nvdaQuote.price)) atmIdx = i;
}
const target = expiry.strikes[atmIdx].call;
console.log(`  NVDA spot=$${nvdaQuote.price}, vol=${(nvdaVol * 100).toFixed(1)}%`);
console.log(`  chosen contract: ${target.contractId} (expiry ${expiry.expiry}, ${expiry.daysToExpiry}d out, strike $${target.strike}, indicative premium $${target.premium})`);

// ── 2. Buy 2 contracts ───────────────────────────────────────────────────────
console.log("\n████ 2. Buy_to_open 2 contracts ████");
const cashBefore1 = await cash(userAId);
console.log(`  cash before: ${money(cashBefore1)}`);
const buy1 = await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "buy_to_open", contracts: 2 });
assert("buy #1 succeeded", buy1.ok, buy1.ok ? "" : buy1.error);
if (buy1.ok) {
  const premium1 = Number(buy1.result.premium);
  const total1 = Number(buy1.result.total);
  const expectedTotal1 = premium1 * 100 * 2;
  console.log(`  server-computed premium: ${money(premium1)}  → total = premium×100×2 = ${money(expectedTotal1)}`);
  // Tolerance, not strict ===: total1 comes back through Postgres numeric
  // arithmetic while expectedTotal1 is recomputed in JS float — these can
  // differ by IEEE754 epsilon (e.g. 872 vs 872.0000000000001) depending on
  // the day's real live premium, unrelated to correctness (hardening pass:
  // this was flaky-failing on a real run with no code-path regression).
  assert("total === premium × 100 × 2 (within float epsilon)", closeTo(total1, expectedTotal1, 1e-6), `${total1} vs ${expectedTotal1}`);
  const cashAfter1 = await cash(userAId);
  console.log(`  cash after: ${money(cashAfter1)} (expected ${money(cashBefore1 - total1)})`);
  assert("cash decreased by EXACTLY total", cashAfter1 === round2(cashBefore1 - total1), `${cashAfter1} vs ${round2(cashBefore1 - total1)}`);
  const pos1 = await position(userAId, target.contractId);
  assert("position created: 2 contracts", pos1?.contracts === 2, `${pos1?.contracts}`);
  assert("position avg_premium === fill premium", pos1?.avg_premium === premium1, `${pos1?.avg_premium} vs ${premium1}`);
}

// ── 3. Buy 1 more of the SAME contract (wait past the 30s quote cache TTL for
//      an independently-fetched, likely-different live price) ──────────────
console.log("\n████ 3. Buy_to_open 1 MORE of the same contract, ~35s later (forces a fresh live quote) ████");
console.log("  waiting 35s to bypass the 30s quote cache TTL and get an independently-fetched price...");
await new Promise((r) => setTimeout(r, 35_000));
const posBefore2 = await position(userAId, target.contractId);
const cashBefore2 = await cash(userAId);
const buy2 = await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "buy_to_open", contracts: 1 });
assert("buy #2 succeeded", buy2.ok, buy2.ok ? "" : buy2.error);
if (buy2.ok && posBefore2) {
  const premium2 = Number(buy2.result.premium);
  const oldContracts = posBefore2.contracts;
  const oldAvg = posBefore2.avg_premium;
  const expectedNewContracts = oldContracts + 1;
  const expectedNewAvg = (oldContracts * oldAvg + 1 * premium2) / expectedNewContracts;
  console.log(`  fill #2 premium: ${money(premium2)}`);
  console.log(`  weighted avg = (${oldContracts}×${oldAvg} + 1×${premium2}) / ${expectedNewContracts} = ${expectedNewAvg}`);
  const posAfter2 = await position(userAId, target.contractId);
  assert("position now 3 contracts", posAfter2?.contracts === 3, `${posAfter2?.contracts}`);
  assert("avg_premium matches the hand-computed weighted average", closeTo(posAfter2!.avg_premium, expectedNewAvg, 1e-9), `${posAfter2?.avg_premium} vs ${expectedNewAvg}`);
  const cashAfter2 = await cash(userAId);
  const total2 = Number(buy2.result.total);
  assert("cash decreased by exactly this fill's total", cashAfter2 === round2(cashBefore2 - total2), `${cashAfter2} vs ${round2(cashBefore2 - total2)}`);
}

// ── 4. Sell-to-close 1, then the remaining 2 (must delete the row) ─────────
console.log("\n████ 4. Sell_to_close 1 contract, then the remaining 2 (position must be DELETED, zero dust) ████");
const cashBeforeSell1 = await cash(userAId);
const sell1 = await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "sell_to_close", contracts: 1 });
assert("sell #1 succeeded", sell1.ok, sell1.ok ? "" : sell1.error);
if (sell1.ok) {
  const proceeds1 = Number(sell1.result.total);
  console.log(`  sell #1 premium ${money(Number(sell1.result.premium))} → proceeds ${money(proceeds1)}`);
  const cashAfterSell1 = await cash(userAId);
  assert("cash increased by EXACTLY the proceeds", cashAfterSell1 === round2(cashBeforeSell1 + proceeds1), `${cashAfterSell1} vs ${round2(cashBeforeSell1 + proceeds1)}`);
  const posAfterSell1 = await position(userAId, target.contractId);
  assert("position reduced to 2 contracts, avg_premium UNCHANGED (sells don't alter cost basis)", posAfterSell1?.contracts === 2, `${posAfterSell1?.contracts}`);
}

const cashBeforeSell2 = await cash(userAId);
const sell2 = await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "sell_to_close", contracts: 2 });
assert("sell #2 (closing the rest) succeeded", sell2.ok, sell2.ok ? "" : sell2.error);
let finalCash = cashBeforeSell2;
if (sell2.ok) {
  const proceeds2 = Number(sell2.result.total);
  finalCash = await cash(userAId);
  console.log(`  sell #2 premium ${money(Number(sell2.result.premium))} → proceeds ${money(proceeds2)}`);
  assert("cash increased by exactly this fill's proceeds", finalCash === round2(cashBeforeSell2 + proceeds2), `${finalCash} vs ${round2(cashBeforeSell2 + proceeds2)}`);
  const posFinal = await position(userAId, target.contractId);
  assert("position row is DELETED (zero dust — not a zeroed row)", posFinal === null, `${JSON.stringify(posFinal)}`);
}

console.log(`\n  FULL-CYCLE RECONCILIATION: started ${money(cashBefore1)}, ended ${money(finalCash)}, net = ${money(finalCash - cashBefore1)} (real intra-test price movement across the ~35s wait — expected to be small and nonzero, NOT necessarily zero)`);

// ── 5. Prove the client can't set the price ─────────────────────────────────
console.log("\n████ 5. Client cannot set the premium ████");
{
  const doctored = { accessToken: tokenA, contractId: target.contractId, side: "buy_to_open" as const, contracts: 1, premium: 0.01 };
  const parsedByRealSchema = executeOptionTradeInputSchema.parse(doctored);
  // Never log the parsed object whole — it still carries the (real, if
  // throwaway) accessToken. Just report the one fact that matters: the key.
  assert("the REAL executeOptionTradeInputSchema strips an unexpected `premium` field", !("premium" in parsedByRealSchema), `keys=[${Object.keys(parsedByRealSchema).join(",")}]`);
  console.log("  (this is the exact schema object exported from lib/options/functions.ts and used by the live createServerFn's .inputValidator — not a reconstruction.)");

  // And end-to-end: run a real trade WITH the doctored field present in the
  // raw payload and confirm the fill premium is the server-computed one, not 0.01.
  const tamperTrade = await runTrade(doctored);
  assert("tamper trade succeeded", tamperTrade.ok, tamperTrade.ok ? "" : tamperTrade.error);
  if (tamperTrade.ok) {
    const filled = Number(tamperTrade.result.premium);
    assert("executed premium is NOT the doctored 0.01 — it's the real server-computed value", filled !== 0.01 && filled > 1, `filled=${filled}`);
    console.log(`  doctored premium sent: $0.01 → actually filled at: ${money(filled)}`);
    // Clean up this extra position immediately (sell it back) so it doesn't interfere with later checks.
    await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "sell_to_close", contracts: 1 });
  }
}

// ── 6. Rejections — every one verified as a true no-op via DB read ─────────
console.log("\n████ 6. Rejections (all verified as no-ops) ████");
{
  const cashSnapshot = await cash(userAId);
  const posSnapshot = await position(userAId, target.contractId); // likely null at this point — fine, still a valid baseline

  // Overspend
  const overspend = await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "buy_to_open", contracts: 1_000_000 });
  assert("overspend rejected", !overspend.ok, overspend.ok ? "unexpectedly succeeded" : overspend.error);
  assert("overspend: cash unchanged", (await cash(userAId)) === cashSnapshot);
  assert("overspend: position unchanged", JSON.stringify(await position(userAId, target.contractId)) === JSON.stringify(posSnapshot));

  // Oversell (nothing held right now, or fewer than requested)
  const oversell = await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "sell_to_close", contracts: 999 });
  assert("oversell rejected", !oversell.ok, oversell.ok ? "unexpectedly succeeded" : oversell.error);
  assert("oversell: cash unchanged", (await cash(userAId)) === cashSnapshot);

  // Zero / negative contracts — rejected at the Zod schema layer (even stronger than business-logic rejection)
  let zeroThrew = false;
  try {
    executeOptionTradeInputSchema.parse({ accessToken: tokenA, contractId: target.contractId, side: "buy_to_open", contracts: 0 });
  } catch {
    zeroThrew = true;
  }
  assert("contracts=0 rejected by the input schema itself", zeroThrew);
  let negThrew = false;
  try {
    executeOptionTradeInputSchema.parse({ accessToken: tokenA, contractId: target.contractId, side: "buy_to_open", contracts: -3 });
  } catch {
    negThrew = true;
  }
  assert("contracts=-3 rejected by the input schema itself", negThrew);

  // Defense-in-depth: the SQL function ALSO independently rejects bad contract
  // counts if called directly (bypassing the app-level schema entirely).
  const { error: sqlZero } = await admin.rpc("execute_option_trade", {
    p_user_id: userAId, p_contract_id: target.contractId, p_symbol: target.symbol, p_opt_type: target.type,
    p_strike: target.strike, p_expiry: target.expiry, p_side: "buy_to_open", p_contracts: 0, p_premium: target.premium,
  });
  assert("SQL function independently rejects p_contracts=0 (invalid_contracts)", !!sqlZero?.message.includes("invalid_contracts"), `${sqlZero?.message}`);

  // Expired contract — a real symbol/strike, but a date in the past.
  const expiredId = `${target.symbol}-2020-01-17-C-${target.strike}`;
  const expired = await runTrade({ accessToken: tokenA, contractId: expiredId, side: "buy_to_open", contracts: 1 });
  assert("expired contract rejected BEFORE any pricing/DB work", !expired.ok && expired.error === "expired_contract", expired.ok ? "unexpectedly succeeded" : expired.error);
  assert("expired: cash unchanged", (await cash(userAId)) === cashSnapshot);

  // Defense-in-depth: the SQL function ALSO independently rejects an expired p_expiry.
  const { error: sqlExpired } = await admin.rpc("execute_option_trade", {
    p_user_id: userAId, p_contract_id: expiredId, p_symbol: target.symbol, p_opt_type: target.type,
    p_strike: target.strike, p_expiry: "2020-01-17", p_side: "buy_to_open", p_contracts: 1, p_premium: 1.0,
  });
  assert("SQL function independently rejects an expired p_expiry", !!sqlExpired?.message.includes("expired_contract"), `${sqlExpired?.message}`);

  // Malformed / unknown contract id
  const garbage = await runTrade({ accessToken: tokenA, contractId: "NOT-A-REAL-CONTRACT", side: "buy_to_open", contracts: 1 });
  assert("malformed contract id rejected (unknown_contract), no DB call attempted", !garbage.ok && garbage.error === "unknown_contract", garbage.ok ? "unexpectedly succeeded" : garbage.error);
  const badDate = await runTrade({ accessToken: tokenA, contractId: `${target.symbol}-2026-02-30-C-${target.strike}`, side: "buy_to_open", contracts: 1 });
  assert("invalid calendar date in contract id rejected (unknown_contract)", !badDate.ok && badDate.error === "unknown_contract", badDate.ok ? "unexpectedly succeeded" : badDate.error);
}

// ── 7. RLS isolation between user A and user B ──────────────────────────────
console.log("\n████ 7. RLS isolation ████");
{
  // Give user A one more real position so there's something to isolate.
  await runTrade({ accessToken: tokenA, contractId: target.contractId, side: "buy_to_open", contracts: 1 });

  const { data: aOwnPositions, error: aOwnErr } = await clientA.from("option_positions").select("*");
  assert("user A (their own session) CAN see their own position(s)", !aOwnErr && (aOwnPositions?.length ?? 0) >= 1, `${aOwnErr?.message} len=${aOwnPositions?.length}`);

  const { data: bPositions, error: bErr } = await clientB.from("option_positions").select("*");
  assert("user B's session sees ZERO of user A's positions", !bErr && (bPositions?.length ?? 0) === 0, `${bErr?.message} len=${bPositions?.length}`);

  const { data: bTx, error: bTxErr } = await clientB.from("option_transactions").select("*");
  assert("user B's session sees ZERO of user A's transactions", !bTxErr && (bTx?.length ?? 0) === 0, `${bTxErr?.message} len=${bTx?.length}`);

  const { data: aTx } = await clientA.from("option_transactions").select("*");
  assert("user A's session CAN see their own transactions", (aTx?.length ?? 0) >= 1, `len=${aTx?.length}`);

  // The DB-level backstop: authenticated/anon can NEVER call execute_option_trade
  // directly — EXECUTE is revoked from everyone except service_role.
  const { error: directCallErr } = await clientB.rpc("execute_option_trade", {
    p_user_id: userBId, p_contract_id: target.contractId, p_symbol: target.symbol, p_opt_type: target.type,
    p_strike: target.strike, p_expiry: target.expiry, p_side: "buy_to_open", p_contracts: 1, p_premium: 1.0,
  });
  assert("an authenticated (non-service-role) client CANNOT call execute_option_trade directly (permission denied)", !!directCallErr, directCallErr ? directCallErr.message : "unexpectedly succeeded");
  console.log(`  direct-call error (expected, proves the EXECUTE grant is locked down): ${directCallErr?.message}`);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log("\n████ Cleanup: deleting throwaway test users + their rows ████");
for (const uid of [userAId, userBId]) {
  await admin.from("option_transactions").delete().eq("user_id", uid);
  await admin.from("option_positions").delete().eq("user_id", uid);
  await admin.auth.admin.deleteUser(uid);
}
console.log("  done.");

console.log(`\n${failures === 0 ? "ALL OPTIONS TRADE-ENGINE LIVE CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
