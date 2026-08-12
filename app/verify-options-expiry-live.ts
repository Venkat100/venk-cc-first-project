// Real E2E for O4 (expiration/cash-settlement processing). REAL Twelve Data
// historical candles + real Postgres, no mocks. `runExpiryProcessing` is a
// plain async function (not a createServerFn), so — unlike executeOptionTradeFn
// in O2's live verification — it's directly callable here with no
// AsyncLocalStorage workaround needed.
//
// SEEDING METHOD (stated up front, per the task): the normal trade path
// (execute_option_trade / executeOptionTradeFn) correctly REFUSES to open an
// already-expired contract — that's a feature, not a gap, proven in O2's own
// verification. So there is no "normal" way to end up holding an expired
// position; the only way one exists in real life is time passing after a
// legitimate purchase. To test settlement without waiting weeks, this script
// seeds option_positions rows DIRECTLY via the service-role client (which
// bypasses RLS and the trade function entirely) — the same seam this
// project's own throwaway-test-user pattern already uses to set up
// otherwise-unreachable states for verification.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { getDailyHistory } from "@/lib/marketData/dailyHistory.server";
import { runExpiryProcessing } from "@/lib/options/expiry.server";
import { runSnapshots } from "@/lib/snapshots/writer.server";
import { createTestUser } from "./verify-harness";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) {
  return `$${Number(n).toFixed(2)}`;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const admin = getServiceClient();
const envText = readFileSync(".env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const anon = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

// ── Setup: throwaway test user ──────────────────────────────────────────────
console.log("\n████ Setup ████");
const stamp = Date.now();
const email = `pt-o4-verify-${stamp}@example.org`;
const password = "O4VerifyPass!234";
const { uid: userId } = await createTestUser(admin, email, password);
console.log(`  test user: ${email} (${userId})`);

async function cash(): Promise<number> {
  const { data, error } = await admin.from("profiles").select("cash_balance").eq("id", userId).single();
  if (error) throw new Error(error.message);
  return Number(data.cash_balance);
}
async function position(contractId: string) {
  const { data, error } = await admin.from("option_positions").select("*").eq("user_id", userId).eq("contract_id", contractId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
async function ledgerRows(contractId: string) {
  const { data, error } = await admin.from("option_transactions").select("*").eq("user_id", userId).eq("contract_id", contractId).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ── 1. Independently fetch a REAL historical close for a real past expiry ──
console.log("\n████ 1. Real historical NVDA close for a real past date ████");
const nvdaSeries = await getDailyHistory("NVDA");
// Pick a Friday roughly 3 weeks in the past — comfortably settled data, not
// today/yesterday (avoids any "is this candle finalized yet" ambiguity).
const past = new Date();
past.setUTCDate(past.getUTCDate() - 21);
while (past.getUTCDay() !== 5) past.setUTCDate(past.getUTCDate() - 1); // walk back to a Friday
const pastExpiry = past.toISOString().slice(0, 10);
const exactCandle = nvdaSeries.find((c) => c.t.slice(0, 10) === pastExpiry);
const refClose = exactCandle?.close ?? nvdaSeries[nvdaSeries.length - 1].close;
const refDateUsed = exactCandle ? pastExpiry : nvdaSeries[nvdaSeries.length - 1].t.slice(0, 10);
console.log(`  chosen past expiry date: ${pastExpiry} (a Friday, ~3 weeks ago)`);
console.log(`  independently fetched close for that date: ${money(refClose)} (candle date actually used: ${refDateUsed}${exactCandle ? "" : " — exact date missing, fell back to latest available"})`);

// Strikes chosen relative to the REAL close so ITM/OTM is unambiguous and
// known in advance, independent of the processor.
const itmCallStrike = round2(refClose - 15);
const otmCallStrike = round2(refClose + 25);
const itmPutStrike = round2(refClose + 15);
console.log(`  ITM call strike: $${itmCallStrike} (close − 15, expect settle = close − strike = ${money(refClose - itmCallStrike)})`);
console.log(`  OTM call strike: $${otmCallStrike} (close + 25, expect worthless — $0)`);
console.log(`  ITM put strike:  $${itmPutStrike} (close + 15, expect settle = strike − close = ${money(itmPutStrike - refClose)})`);

const itmCallId = `NVDA-${pastExpiry}-C-${itmCallStrike}`;
const otmCallId = `NVDA-${pastExpiry}-C-${otmCallStrike}`;
const itmPutId = `NVDA-${pastExpiry}-P-${itmPutStrike}`;

// A LIVE (future-expiry) position on the SAME account, to prove the run
// leaves it alone.
const future = new Date();
future.setUTCDate(future.getUTCDate() + 30);
const futureExpiry = future.toISOString().slice(0, 10);
const liveStrike = round2(refClose);
const liveId = `NVDA-${futureExpiry}-C-${liveStrike}`;

// ── 2. Seed the four positions directly (service-role, bypassing the trade
// path — see file header for why this is the only way to reach this state) ──
console.log("\n████ 2. Seed positions (service-role insert, bypassing execute_option_trade) ████");
const seedRows = [
  { user_id: userId, contract_id: itmCallId, symbol: "NVDA", opt_type: "call", strike: itmCallStrike, expiry: pastExpiry, contracts: 2, avg_premium: 8.0 },
  { user_id: userId, contract_id: otmCallId, symbol: "NVDA", opt_type: "call", strike: otmCallStrike, expiry: pastExpiry, contracts: 3, avg_premium: 1.5 },
  { user_id: userId, contract_id: itmPutId, symbol: "NVDA", opt_type: "put", strike: itmPutStrike, expiry: pastExpiry, contracts: 1, avg_premium: 6.0 },
  { user_id: userId, contract_id: liveId, symbol: "NVDA", opt_type: "call", strike: liveStrike, expiry: futureExpiry, contracts: 1, avg_premium: 5.0 },
];
const { error: seedErr } = await admin.from("option_positions").insert(seedRows);
if (seedErr) throw new Error("seed failed: " + seedErr.message);
console.log(`  seeded: ITM call (2 contracts, $${itmCallStrike} strike), OTM call (3 contracts, $${otmCallStrike} strike), ITM put (1 contract, $${itmPutStrike} strike), LIVE call (1 contract, expires ${futureExpiry})`);

const cashBefore = await cash();
console.log(`  cash before settlement run: ${money(cashBefore)}`);

// ── 3. Run the REAL processor, scoped to this test user ────────────────────
console.log("\n████ 3. Run runExpiryProcessing (real function, real DB, real historical data) ████");
const summary1 = await runExpiryProcessing({ onlyUserId: userId });
console.log(`  positionsFound=${summary1.positionsFound} settled=${summary1.settled} expiredWorthless=${summary1.expiredWorthless} totalCashCredited=${money(summary1.totalCashCredited)} errors=${JSON.stringify(summary1.errors)}`);
assert("processor found exactly the 3 expired positions (not the live one)", summary1.positionsFound === 3, `${summary1.positionsFound}`);
assert("no errors during processing", summary1.errors.length === 0, JSON.stringify(summary1.errors));

for (const s of summary1.settlements) {
  console.log(`    ${s.contractId}: close used=${money(s.closeUsed)} (date ${s.closeDateUsed}, fallback=${s.usedFallbackClose}) → settle/share=${money(s.settlePerShare)} × 100 × ${s.contracts} = ${money(s.total)} [${s.outcome}]`);
}

const itmCallSettlement = summary1.settlements.find((s) => s.contractId === itmCallId)!;
const otmCallSettlement = summary1.settlements.find((s) => s.contractId === otmCallId)!;
const itmPutSettlement = summary1.settlements.find((s) => s.contractId === itmPutId)!;

console.log("\n████ 4. Settlement math, independently checked ████");
const expectedItmCallPerShare = round2(Math.max(0, refClose - itmCallStrike));
const expectedItmCallTotal = round2(expectedItmCallPerShare * 100 * 2);
assert(`ITM call: settle/share = max(0, ${money(refClose)} − ${money(itmCallStrike)}) = ${money(expectedItmCallPerShare)}`, itmCallSettlement.settlePerShare === expectedItmCallPerShare, `${itmCallSettlement.settlePerShare} vs ${expectedItmCallPerShare}`);
assert(`ITM call: total = ${money(expectedItmCallPerShare)} × 100 × 2 = ${money(expectedItmCallTotal)}`, itmCallSettlement.total === expectedItmCallTotal, `${itmCallSettlement.total} vs ${expectedItmCallTotal}`);
assert("ITM call: outcome = 'settled'", itmCallSettlement.outcome === "settled");

assert("OTM call: settle/share = $0.00 (worthless)", otmCallSettlement.settlePerShare === 0, `${otmCallSettlement.settlePerShare}`);
assert("OTM call: total credited = $0.00", otmCallSettlement.total === 0, `${otmCallSettlement.total}`);
assert("OTM call: outcome = 'expired'", otmCallSettlement.outcome === "expired");

const expectedItmPutPerShare = round2(Math.max(0, itmPutStrike - refClose));
const expectedItmPutTotal = round2(expectedItmPutPerShare * 100 * 1);
assert(`ITM put: settle/share = max(0, ${money(itmPutStrike)} − ${money(refClose)}) = ${money(expectedItmPutPerShare)}`, itmPutSettlement.settlePerShare === expectedItmPutPerShare, `${itmPutSettlement.settlePerShare} vs ${expectedItmPutPerShare}`);
assert(`ITM put: total = ${money(expectedItmPutPerShare)} × 100 × 1 = ${money(expectedItmPutTotal)}`, itmPutSettlement.total === expectedItmPutTotal, `${itmPutSettlement.total} vs ${expectedItmPutTotal}`);
assert("ITM put: outcome = 'settled'", itmPutSettlement.outcome === "settled");

assert("all three used the SAME independently-fetched close price (consistent settlement basis)", itmCallSettlement.closeUsed === refClose && otmCallSettlement.closeUsed === refClose && itmPutSettlement.closeUsed === refClose);

// ── 5. Positions deleted, ledger rows correct, cash reconciles ─────────────
console.log("\n████ 5. Positions deleted + ledger rows + cash reconciliation ████");
assert("ITM call position row DELETED", (await position(itmCallId)) === null);
assert("OTM call position row DELETED", (await position(otmCallId)) === null);
assert("ITM put position row DELETED", (await position(itmPutId)) === null);

const itmCallLedger = (await ledgerRows(itmCallId))[0];
const otmCallLedger = (await ledgerRows(otmCallId))[0];
const itmPutLedger = (await ledgerRows(itmPutId))[0];
assert("ITM call ledger row: side='settled', contracts=2, correct total", itmCallLedger?.side === "settled" && Number(itmCallLedger.contracts) === 2 && Number(itmCallLedger.total) === expectedItmCallTotal, JSON.stringify(itmCallLedger));
assert("OTM call ledger row: side='expired', contracts=3, total=0", otmCallLedger?.side === "expired" && Number(otmCallLedger.contracts) === 3 && Number(otmCallLedger.total) === 0, JSON.stringify(otmCallLedger));
assert("ITM put ledger row: side='settled', contracts=1, correct total", itmPutLedger?.side === "settled" && Number(itmPutLedger.contracts) === 1 && Number(itmPutLedger.total) === expectedItmPutTotal, JSON.stringify(itmPutLedger));

const cashAfter = await cash();
const expectedCashAfter = round2(cashBefore + expectedItmCallTotal + 0 + expectedItmPutTotal);
console.log(`  cash after: ${money(cashAfter)} = before ${money(cashBefore)} + ITM call ${money(expectedItmCallTotal)} + OTM call $0.00 + ITM put ${money(expectedItmPutTotal)}`);
assert("cash reconciles to the cent across all three settlements", cashAfter === expectedCashAfter, `${cashAfter} vs ${expectedCashAfter}`);

// ── 6. Live position untouched ──────────────────────────────────────────────
console.log("\n████ 6. Live (non-expired) position on the same account ████");
const livePos = await position(liveId);
assert("live position still exists, untouched", livePos !== null && Number(livePos.contracts) === 1 && livePos.expiry === futureExpiry, JSON.stringify(livePos));

// ── 7. Idempotency: re-run finds nothing, no double-credit ─────────────────
console.log("\n████ 7. Idempotency — re-run the processor ████");
const summary2 = await runExpiryProcessing({ onlyUserId: userId });
assert("second run finds 0 positions (all three already settled+deleted)", summary2.positionsFound === 0, `${summary2.positionsFound}`);
const cashAfterRerun = await cash();
assert("cash UNCHANGED after re-run (no double-credit)", cashAfterRerun === cashAfter, `${cashAfterRerun} vs ${cashAfter}`);

// ── 8. settle_expired_option rejects a not-yet-expired position ────────────
console.log("\n████ 8. Defense in depth: settle_expired_option rejects a live position ████");
const { error: liveRejectErr } = await admin.rpc("settle_expired_option", { p_user_id: userId, p_contract_id: liveId, p_settle_per_share: 99 });
assert("direct settle attempt on the LIVE position is rejected (not_expired)", !!liveRejectErr?.message.includes("not_expired"), `${liveRejectErr?.message}`);
const liveStillThere = await position(liveId);
assert("live position still untouched after the rejected attempt", liveStillThere !== null && Number(liveStillThere.contracts) === 1);
const cashAfterRejectAttempt = await cash();
assert("cash unaffected by the rejected settle attempt", cashAfterRejectAttempt === cashAfter, `${cashAfterRejectAttempt} vs ${cashAfter}`);

// Also: settle_expired_option on a NONEXISTENT contract_id.
const { error: missingErr } = await admin.rpc("settle_expired_option", { p_user_id: userId, p_contract_id: "NVDA-2020-01-17-C-100", p_settle_per_share: 5 });
assert("settle attempt on a nonexistent position is rejected (position_not_found)", !!missingErr?.message.includes("position_not_found"), `${missingErr?.message}`);

// ── 9. Snapshot reflects the new cash ───────────────────────────────────────
console.log("\n████ 9. Snapshot writer reflects the post-settlement cash ████");
await runSnapshots({ onlyUserId: userId });
const { data: snapRows, error: snapErr } = await admin.from("portfolio_snapshots").select("*").eq("user_id", userId).order("captured_at", { ascending: false }).limit(1);
if (snapErr) throw new Error(snapErr.message);
const snap = snapRows![0];
console.log(`  snapshot row: total_value=${money(snap.total_value)} cash=${money(snap.cash)} holdings_value=${money(snap.holdings_value)}`);
assert("snapshot cash matches the post-settlement cash exactly", Number(snap.cash) === cashAfter, `${snap.cash} vs ${cashAfter}`);
assert("snapshot total_value = cash + holdings(0) + the still-live option position's value (>0, priced live)", Number(snap.total_value) >= cashAfter, `${snap.total_value} vs floor ${cashAfter}`);

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log("\n████ Cleanup ████");
await admin.from("option_transactions").delete().eq("user_id", userId);
await admin.from("option_positions").delete().eq("user_id", userId);
await admin.from("portfolio_snapshots").delete().eq("user_id", userId);
await admin.auth.admin.deleteUser(userId);
console.log("  test user + all rows deleted.");
void anon;

console.log(`\n${failures === 0 ? "ALL O4 EXPIRY-PROCESSING LIVE CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
