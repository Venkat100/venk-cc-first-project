// Real E2E for M1 (the margin engine — server-side only, no UI yet). REAL
// Postgres + real Finnhub/Twelve Data quotes, no mocks. Scoped to ONE primary
// throwaway test user for the whole margin-off → margin-on narrative; a
// SECOND, lightweight user exists only for the final RLS cross-isolation
// check. Both deleted at the end.
//
// METHODOLOGY NOTE: setMarginEnabledFn/repayMarginFn/getMarginStateFn/
// executeTradeFn/executeOptionTradeFn are all TanStack Start `createServerFn`s
// — confirmed in O2/O4 that these throw "No Start context found in
// AsyncLocalStorage" outside the real server runtime. Same workaround as
// every prior live-verify script: call the underlying REAL functions/RPCs
// directly, in the same order the handlers do.
//
// SEEDING SEAM: forcing a margin call/warning without a real price crash, and
// testing non-same-day interest accrual without waiting a real day, both
// need to write `margin_loan` / `last_interest_accrued_at` directly.
// `service_role` deliberately has NO blanket UPDATE grant on `profiles` (see
// 0013's header for the full story — a real, previously-untested gap this
// script's first attempt discovered, NOT a stuck lock: a live diagnostic
// call returned Postgres 42501 "permission denied for table profiles"
// almost instantly, with the hint "GRANT UPDATE ON public.profiles TO
// service_role"). Rather than weaken that (a real security property), 0013
// adds one narrow service_role-only RPC, `admin_seed_margin_state`, scoped
// to exactly those two columns — used below instead of a raw table update.
//
// HARNESS ROBUSTNESS (added after a prior run of this exact script appeared
// to hang for hours): every await here is wrapped in withTimeout() so a
// stalled call throws a clearly-labeled error within a bounded time instead
// of blocking forever, every step prints a timestamped line before AND
// after it runs, and the entire body is inside one try/catch that explicitly
// calls process.exit() — vite-node's SSR module runtime does not reliably
// terminate the process on an uncaught top-level exception the way a plain
// Node script would, so relying on that was the actual root cause of the
// apparent "hang": a real (fast) permission error was thrown, uncaught, and
// vite-node's process stayed resident afterward instead of exiting.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { getRealizedVol } from "@/lib/options/volatility.server";
import { buildChain, parseContractId, priceParsedContract } from "@/lib/options/chain.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { runInterestAccrual } from "@/lib/margin/interest.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { MARGIN_INTEREST_RATE, MARGIN_MAINTENANCE_PCT, MARGIN_MAX_LEVERAGE, MARGIN_WARNING_BUFFER_PCT } from "@/lib/margin/config.server";

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
function closeTo(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}
function buyingPowerJs(cash: number, loan: number, marginEnabled: boolean, positionsValue: number) {
  if (!marginEnabled) return cash;
  return Math.max(0, MARGIN_MAX_LEVERAGE * (cash + positionsValue - loan) - positionsValue);
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
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
  const env = Object.fromEntries(
    envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  const anonUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;

  console.log("\n████ Setup: primary throwaway test user ████");
  const stamp = Date.now();
  const PASSWORD = "M1VerifyPass!234";
  const email = `pt-m1-verify-${stamp}@example.org`;
  const created = await step("create primary test user", 15000, () => admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true }));
  if (created.error || !created.data.user) throw new Error(`user creation failed: ${created.error?.message}`);
  const uid = created.data.user.id;
  console.log(`  primary test user: ${email} (${uid})`);

  const client = createClient(anonUrl, anonKey);
  const signIn = await step("sign in primary test user", 15000, () => client.auth.signInWithPassword({ email, password: PASSWORD }));
  if (signIn.error || !signIn.data.session) throw new Error(`sign-in failed: ${signIn.error?.message}`);

  async function profileRow(userId: string) {
    const { data, error } = await withTimeout(`select profiles ${userId}`, admin.from("profiles").select("cash_balance, margin_enabled, margin_loan, margin_status").eq("id", userId).single());
    if (error) throw new Error(error.message);
    return { cash: Number(data.cash_balance), marginEnabled: Boolean(data.margin_enabled), marginLoan: Number(data.margin_loan), marginStatus: data.margin_status as string };
  }
  async function holdingQty(userId: string, symbol: string) {
    const { data } = await withTimeout(`select holding ${symbol}`, admin.from("holdings").select("quantity, avg_cost").eq("user_id", userId).eq("symbol", symbol).maybeSingle());
    return data ? { quantity: Number(data.quantity), avgCost: Number(data.avg_cost) } : null;
  }
  async function optionPosition(userId: string, contractId: string) {
    const { data } = await withTimeout(`select option position ${contractId}`, admin.from("option_positions").select("contracts, avg_premium").eq("user_id", userId).eq("contract_id", contractId).maybeSingle());
    return data ? { contracts: Number(data.contracts), avgPremium: Number(data.avg_premium) } : null;
  }
  async function marginEvents(userId: string) {
    const { data, error } = await withTimeout(`select margin_events ${userId}`, admin.from("margin_events").select("*").eq("user_id", userId).order("created_at", { ascending: true }));
    if (error) throw new Error(error.message);
    return data ?? [];
  }
  async function seedMarginState(userId: string, marginLoan?: number, lastInterestAccruedAt?: string) {
    const { data, error } = await withTimeout("admin_seed_margin_state RPC", admin.rpc("admin_seed_margin_state", { p_user_id: userId, p_margin_loan: marginLoan ?? null, p_last_interest_accrued_at: lastInterestAccruedAt ?? null }));
    if (error) throw new Error("seed failed: " + error.message);
    return data as { margin_loan: number; last_interest_accrued_at: string };
  }

  async function buyStock(userId: string, symbol: string, quantity: number) {
    const quote = await withTimeout(`quote ${symbol}`, getServerQuote(symbol));
    const profile = await profileRow(userId);
    const positionsValue = profile.marginEnabled ? await withTimeout("getPositionsValue", getPositionsValue(userId), 20000) : 0;
    const { data, error } = await withTimeout("execute_trade RPC (buy)", admin.rpc("execute_trade", {
      p_user_id: userId, p_symbol: symbol, p_side: "buy", p_quantity: quantity, p_price: quote.price, p_positions_value: positionsValue,
    }));
    return { data: data as Record<string, unknown> | null, error, price: quote.price, positionsValue };
  }
  async function sellStock(userId: string, symbol: string, quantity: number) {
    const quote = await withTimeout(`quote ${symbol}`, getServerQuote(symbol));
    const profile = await profileRow(userId);
    const positionsValue = profile.marginEnabled ? await withTimeout("getPositionsValue", getPositionsValue(userId), 20000) : 0;
    const { data, error } = await withTimeout("execute_trade RPC (sell)", admin.rpc("execute_trade", {
      p_user_id: userId, p_symbol: symbol, p_side: "sell", p_quantity: quantity, p_price: quote.price, p_positions_value: positionsValue,
    }));
    return { data: data as Record<string, unknown> | null, error, price: quote.price, positionsValue };
  }
  async function tradeOption(userId: string, contractId: string, side: "buy_to_open" | "sell_to_close", contracts: number) {
    const parsed = parseContractId(contractId)!;
    const [quote, vol] = await withTimeout("quote+vol for option", Promise.all([getServerQuote(parsed.symbol), getRealizedVol(parsed.symbol)]), 20000);
    const priced = priceParsedContract(parsed, quote.price, vol);
    const profile = await profileRow(userId);
    const positionsValue = profile.marginEnabled ? await withTimeout("getPositionsValue", getPositionsValue(userId), 20000) : 0;
    const { data, error } = await withTimeout("execute_option_trade RPC", admin.rpc("execute_option_trade", {
      p_user_id: userId, p_contract_id: contractId, p_symbol: parsed.symbol, p_opt_type: parsed.type, p_strike: parsed.strike, p_expiry: parsed.expiry,
      p_side: side, p_contracts: contracts, p_premium: priced.premium, p_positions_value: positionsValue,
    }));
    return { data: data as Record<string, unknown> | null, error, premium: priced.premium };
  }

  // ════════════════════════════════════════════════════════════════════════
  // (1) MARGIN OFF — regression proof
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n████ (1) Margin OFF — regression suite (stock + options) ████");
  {
    const p0 = await profileRow(uid);
    assert("margin_enabled defaults to false", p0.marginEnabled === false);
    assert("margin_loan defaults to 0", p0.marginLoan === 0);
    console.log(`  starting cash: ${money(p0.cash)}`);

    const b1 = await step("buy 10 NVDA (within cash)", 20000, () => buyStock(uid, "NVDA", 10));
    assert("stock buy (10 NVDA, within cash) succeeds", !b1.error, b1.error?.message);
    if (b1.data) {
      const total = Number(b1.data.total);
      const cashAfter = await profileRow(uid);
      console.log(`  bought 10 NVDA @ ${money(b1.price)} = ${money(total)}; cash ${money(p0.cash)} → ${money(cashAfter.cash)}`);
      assert("cash decreased by exactly total, margin_loan stays 0", closeTo(cashAfter.cash, round2(p0.cash - total)) && cashAfter.marginLoan === 0, `${cashAfter.cash} vs ${round2(p0.cash - total)}, loan=${cashAfter.marginLoan}`);
      assert("RPC returned margin_loan=0 (unaffected)", Number(b1.data.margin_loan) === 0);
    }

    const cashSnap = await profileRow(uid);
    const q = await step("quote NVDA (for overspend sizing)", 15000, () => getServerQuote("NVDA"));
    const hugeQty = Math.ceil((cashSnap.cash * 100) / q.price);
    const bReject = await step("buy huge qty (expect reject)", 20000, () => buyStock(uid, "NVDA", hugeQty));
    assert("stock buy exceeding cash REJECTED (margin off)", !!bReject.error?.message.includes("insufficient_funds"), bReject.error?.message);
    const afterReject = await profileRow(uid);
    assert("rejected buy: cash + loan unchanged", afterReject.cash === cashSnap.cash && afterReject.marginLoan === 0);

    const oversell = await step("oversell (expect reject)", 20000, () => sellStock(uid, "NVDA", 9999));
    assert("stock oversell REJECTED", !!oversell.error?.message.includes("insufficient_shares"), oversell.error?.message);

    const cashBeforeSell = await profileRow(uid);
    const sellPartial = await step("sell 4 of 10 NVDA", 20000, () => sellStock(uid, "NVDA", 4));
    assert("sell 4 of 10 succeeds", !sellPartial.error, sellPartial.error?.message);
    if (sellPartial.data) {
      const proceeds = Number(sellPartial.data.total);
      const after = await profileRow(uid);
      assert("cash increased by exactly proceeds, ALL to cash (loan stays 0)", closeTo(after.cash, round2(cashBeforeSell.cash + proceeds)) && after.marginLoan === 0, `${after.cash} vs ${round2(cashBeforeSell.cash + proceeds)}`);
    }
    const holdingMid = await holdingQty(uid, "NVDA");
    assert("holding reduced to 6", holdingMid?.quantity === 6, `${holdingMid?.quantity}`);
    const sellRest = await step("sell remaining 6 NVDA", 20000, () => sellStock(uid, "NVDA", 6));
    assert("sell remaining 6 succeeds", !sellRest.error, sellRest.error?.message);
    const holdingFinal = await holdingQty(uid, "NVDA");
    assert("holding row DELETED (zero dust)", holdingFinal === null);

    const [nvdaQuote, nvdaVol] = await step("quote+vol NVDA (for chain)", 20000, () => Promise.all([getServerQuote("NVDA"), getRealizedVol("NVDA")]));
    const chain = buildChain({ symbol: "NVDA", spot: nvdaQuote.price, vol: nvdaVol });
    const expiry = chain.expiries.find((e) => e.daysToExpiry > 0) ?? chain.expiries[0];
    let atmIdx = 0;
    for (let i = 1; i < expiry.strikes.length; i++) {
      if (Math.abs(expiry.strikes[i].strike - nvdaQuote.price) < Math.abs(expiry.strikes[atmIdx].strike - nvdaQuote.price)) atmIdx = i;
    }
    const contract = expiry.strikes[atmIdx].call;
    console.log(`  option contract for OFF-suite: ${contract.contractId}`);

    const oBuy = await step("option buy_to_open 1", 20000, () => tradeOption(uid, contract.contractId, "buy_to_open", 1));
    assert("option buy_to_open (1 contract, within cash) succeeds", !oBuy.error, oBuy.error?.message);
    if (oBuy.data) assert("RPC returned margin_loan=0", Number(oBuy.data.margin_loan) === 0);

    const oOverspend = await step("option buy_to_open 100000 (expect reject)", 20000, () => tradeOption(uid, contract.contractId, "buy_to_open", 100000));
    assert("option buy exceeding cash REJECTED (margin off)", !!oOverspend.error?.message.includes("insufficient_funds"), oOverspend.error?.message);

    const cashBeforeOptSell = await profileRow(uid);
    const oSell = await step("option sell_to_close 1 (full)", 20000, () => tradeOption(uid, contract.contractId, "sell_to_close", 1));
    assert("option sell_to_close (full) succeeds", !oSell.error, oSell.error?.message);
    if (oSell.data) {
      const proceeds = Number(oSell.data.total);
      const after = await profileRow(uid);
      assert("cash increased by exactly proceeds, loan stays 0", closeTo(after.cash, round2(cashBeforeOptSell.cash + proceeds)) && after.marginLoan === 0);
    }
    const optFinal = await optionPosition(uid, contract.contractId);
    assert("option position row DELETED (zero dust)", optFinal === null);

    const eventsOff = await marginEvents(uid);
    assert("NO margin_events rows for a user who never touched margin", eventsOff.length === 0, `${eventsOff.length}`);

    console.log(`  ${failures === 0 ? "margin-OFF regression suite: all identical to pre-M1 behavior" : "margin-OFF regression suite: SEE FAILURES ABOVE"}`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // (2)-(7) MARGIN ON — the full narrative, same account
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n████ (2) Enable margin ████");
  {
    const { error } = await step("set_margin_enabled(true)", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
    assert("set_margin_enabled(true) succeeds", !error, error?.message);
    const p = await profileRow(uid);
    assert("margin_enabled = true, margin_loan = 0", p.marginEnabled === true && p.marginLoan === 0);
    const events = await marginEvents(uid);
    assert("'enabled' event logged", events.length === 1 && events[0].kind === "enabled", JSON.stringify(events));
  }

  console.log("\n████ (2) Buy ~$150k of NVDA on $100k equity ████");
  let nvdaHeldQty = 0;
  {
    const p0 = await profileRow(uid);
    const quote = await step("quote NVDA", 15000, () => getServerQuote("NVDA"));
    const targetDollars = 150000;
    const qty = Math.round((targetDollars / quote.price) * 1e6) / 1e6;
    console.log(`  cash=${money(p0.cash)}, positions_value=$0.00 (no positions yet) → buying_power = 2×equity−positions = 2×${money(p0.cash)} = ${money(buyingPowerJs(p0.cash, 0, true, 0))}`);
    const buy = await step("buy ~$150k NVDA on margin", 25000, () => buyStock(uid, "NVDA", qty));
    assert("buy of ~$150k succeeds (within buying power)", !buy.error, buy.error?.message);
    if (buy.data) {
      const total = Number(buy.data.total);
      const cashUsed = Math.min(total, p0.cash);
      const borrowed = Math.max(0, total - p0.cash);
      const after = await profileRow(uid);
      nvdaHeldQty = qty;
      console.log(`  bought ${qty} NVDA @ ${money(buy.price)} = ${money(total)}`);
      console.log(`  cash_used = min(${money(total)}, ${money(p0.cash)}) = ${money(cashUsed)}`);
      console.log(`  borrowed  = max(0, ${money(total)} − ${money(p0.cash)}) = ${money(borrowed)}`);
      console.log(`  cash: ${money(p0.cash)} → ${money(after.cash)}  (expected ${money(round2(p0.cash - cashUsed))})`);
      console.log(`  loan: $0.00 → ${money(after.marginLoan)}  (expected ${money(round2(borrowed))})`);
      assert("cash reduced by exactly cash_used", closeTo(after.cash, round2(p0.cash - cashUsed)));
      assert("margin_loan increased by exactly borrowed (sub-cent float noise tolerated — v_total isn't rounded to the cent in execute_trade, unchanged from pre-M1)", closeTo(after.marginLoan, round2(borrowed)), `${after.marginLoan} vs ${round2(borrowed)}`);
      const positionsValueAfter = await step("getPositionsValue after buy", 20000, () => getPositionsValue(uid));
      const equityAfter = round2(after.cash + positionsValueAfter - after.marginLoan);
      console.log(`  positions_value≈${money(positionsValueAfter)}, equity = cash+positions_value−loan = ${money(after.cash)}+${money(positionsValueAfter)}−${money(after.marginLoan)} = ${money(equityAfter)} (should still ≈ starting equity $100,000 — leverage doesn't change equity)`);
      assert("equity unchanged by borrowing (within a few cents of $100,000 — small drift = real price ticks)", Math.abs(equityAfter - 100000) < 200, `${equityAfter}`);
      const borrowEvents = (await marginEvents(uid)).filter((e) => e.kind === "borrow");
      assert("'borrow' event logged with correct amount", borrowEvents.length === 1 && closeTo(Number(borrowEvents[0].amount), borrowed), JSON.stringify(borrowEvents));
    }
  }

  console.log("\n████ (2) Attempt to exceed 2× buying power → rejected, no state change ████");
  {
    const p = await profileRow(uid);
    const positionsValue = await step("getPositionsValue", 20000, () => getPositionsValue(uid));
    const bp = buyingPowerJs(p.cash, p.marginLoan, true, positionsValue);
    console.log(`  cash=${money(p.cash)}, positions_value=${money(positionsValue)}, loan=${money(p.marginLoan)}`);
    console.log(`  equity = ${money(p.cash)}+${money(positionsValue)}−${money(p.marginLoan)} = ${money(round2(p.cash + positionsValue - p.marginLoan))}`);
    console.log(`  buying_power = max(0, 2×equity − positions_value) = ${money(bp)}  ← remaining room`);
    const overshootDollars = bp + 20000;
    const quote = await step("quote NVDA", 15000, () => getServerQuote("NVDA"));
    const overshootQty = Math.round((overshootDollars / quote.price) * 1e6) / 1e6;
    const holdBefore = await holdingQty(uid, "NVDA");
    const attempt = await step("buy overshoot qty (expect reject)", 25000, () => buyStock(uid, "NVDA", overshootQty));
    assert(`buy of ${money(overshootDollars)} (> remaining buying power ${money(bp)}) REJECTED`, !!attempt.error?.message.includes("insufficient_funds"), attempt.error?.message);
    const pAfter = await profileRow(uid);
    const holdAfter = await holdingQty(uid, "NVDA");
    assert("no state change: cash, loan, position all identical after the rejected attempt", pAfter.cash === p.cash && pAfter.marginLoan === p.marginLoan && holdAfter?.quantity === holdBefore?.quantity, `cash ${p.cash}→${pAfter.cash}, loan ${p.marginLoan}→${pAfter.marginLoan}, qty ${holdBefore?.quantity}→${holdAfter?.quantity}`);
  }

  console.log("\n████ (3) Interest accrual arithmetic + same-day idempotency ████");
  {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await step("seed last_interest_accrued_at = yesterday (via admin_seed_margin_state RPC)", 15000, () => seedMarginState(uid, undefined, yesterday));
    console.log(`  (backdated last_interest_accrued_at to ${yesterday} so accrual isn't a same-day no-op — set_margin_enabled(true) had stamped it to today)`);

    const before = await profileRow(uid);
    const expectedInterest = round2((before.marginLoan * MARGIN_INTEREST_RATE) / 365);
    console.log(`  loan=${money(before.marginLoan)}, rate=${MARGIN_INTEREST_RATE * 100}% → interest = round(${money(before.marginLoan)} × ${MARGIN_INTEREST_RATE} / 365, 2) = ${money(expectedInterest)}`);
    const run1 = await step("runInterestAccrual (1st, should accrue)", 15000, () => runInterestAccrual({ onlyUserId: uid }));
    assert("first accrual run: accrued=1, totalInterest matches", run1.accrued === 1 && run1.totalInterest === expectedInterest, JSON.stringify(run1));
    const after1 = await profileRow(uid);
    console.log(`  loan: ${money(before.marginLoan)} → ${money(after1.marginLoan)}  (expected ${money(round2(before.marginLoan + expectedInterest))})`);
    assert("loan increased by EXACTLY the computed interest", closeTo(after1.marginLoan, round2(before.marginLoan + expectedInterest)));
    const interestEvents1 = (await marginEvents(uid)).filter((e) => e.kind === "interest");
    assert("'interest' event logged", interestEvents1.length === 1 && round2(Number(interestEvents1[0].amount)) === expectedInterest);

    const run2 = await step("runInterestAccrual (2nd, same day, should no-op)", 15000, () => runInterestAccrual({ onlyUserId: uid }));
    assert("SAME-DAY re-run: accrued=0 (idempotent)", run2.accrued === 0 && run2.totalInterest === 0, JSON.stringify(run2));
    const after2 = await profileRow(uid);
    assert("loan UNCHANGED after same-day re-run", after2.marginLoan === after1.marginLoan, `${after2.marginLoan} vs ${after1.marginLoan}`);
  }

  console.log("\n████ (7) Disable margin while loan is outstanding → rejected ████");
  {
    const before = await profileRow(uid);
    const { error } = await step("set_margin_enabled(false) with loan outstanding (expect reject)", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: false }));
    assert("disable REJECTED with loan_outstanding", !!error?.message.includes("loan_outstanding"), error?.message);
    const after = await profileRow(uid);
    assert("no state change from the rejected disable attempt", after.marginEnabled === before.marginEnabled && after.marginLoan === before.marginLoan);
  }

  console.log("\n████ (4) Sell proceeds pay down the loan FIRST, then cash (show the split) ████");
  {
    const before = await profileRow(uid);
    const sellQty = round2(nvdaHeldQty / 2);
    const quotePreview = await step("quote NVDA (preview)", 15000, () => getServerQuote("NVDA"));
    console.log(`  selling half the position (${sellQty} of ${nvdaHeldQty} NVDA @ ~${money(quotePreview.price)}) — proceeds expected to comfortably exceed the loan (${money(before.marginLoan)}), producing a REAL split`);
    const sell = await step("sell half NVDA position", 25000, () => sellStock(uid, "NVDA", sellQty));
    assert("sell succeeds", !sell.error, sell.error?.message);
    if (sell.data) {
      const proceeds = Number(sell.data.total);
      const loanRepaid = Math.min(proceeds, before.marginLoan);
      const cashCredit = proceeds - loanRepaid;
      const after = await profileRow(uid);
      console.log(`  proceeds = ${money(proceeds)}`);
      console.log(`  loan_repaid = min(${money(proceeds)}, ${money(before.marginLoan)}) = ${money(loanRepaid)}`);
      console.log(`  cash_credit = ${money(proceeds)} − ${money(loanRepaid)} = ${money(cashCredit)}`);
      console.log(`  loan: ${money(before.marginLoan)} → ${money(after.marginLoan)}  (expected ${money(round2(before.marginLoan - loanRepaid))})`);
      console.log(`  cash: ${money(before.cash)} → ${money(after.cash)}  (expected ${money(round2(before.cash + cashCredit))})`);
      assert("loan reduced by exactly loan_repaid", closeTo(after.marginLoan, round2(before.marginLoan - loanRepaid)));
      assert("cash increased by exactly cash_credit (the remainder, NOT the full proceeds)", closeTo(after.cash, round2(before.cash + cashCredit)));
      assert("this was a REAL split: both loan_repaid > 0 AND cash_credit > 0", loanRepaid > 0 && cashCredit > 0, `loan_repaid=${loanRepaid}, cash_credit=${cashCredit}`);
      assert("loan reached exactly 0 → margin_status reset to 'ok'", after.marginLoan === 0 && after.marginStatus === "ok", `loan=${after.marginLoan}, status=${after.marginStatus}`);
      const repayEvents = (await marginEvents(uid)).filter((e) => e.kind === "repay");
      assert("'repay' event logged (auto=true) with amount = loan_repaid", repayEvents.length === 1 && closeTo(Number(repayEvents[0].amount), loanRepaid), JSON.stringify(repayEvents));
    }
  }

  console.log("\n████ (7) Repay-to-zero achieved → disable now succeeds ████");
  {
    const before = await profileRow(uid);
    assert("precondition: loan is exactly 0", before.marginLoan === 0, `${before.marginLoan}`);
    const { error } = await step("set_margin_enabled(false) with loan=0 (expect success)", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: false }));
    assert("disable SUCCEEDS now that loan is 0", !error, error?.message);
    const after = await profileRow(uid);
    assert("margin_enabled = false", after.marginEnabled === false);
    const { error: reErr } = await step("set_margin_enabled(true) re-enable", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
    assert("re-enable succeeds", !reErr, reErr?.message);
    const afterRe = await profileRow(uid);
    assert("margin_enabled = true again, loan still 0", afterRe.marginEnabled === true && afterRe.marginLoan === 0);
  }

  console.log("\n████ Re-establish a fresh loan (needed as a precondition for warning/call) ████");
  {
    const before = await profileRow(uid);
    const positionsValue = await step("getPositionsValue", 20000, () => getPositionsValue(uid));
    const quote = await step("quote NVDA", 15000, () => getServerQuote("NVDA"));
    const targetDollars = round2(before.cash + 20000);
    const qty = Math.round((targetDollars / quote.price) * 1e6) / 1e6;
    const bp = buyingPowerJs(before.cash, 0, true, positionsValue);
    console.log(`  cash=${money(before.cash)}, positions_value=${money(positionsValue)}, buying_power=${money(bp)} → buying ${money(targetDollars)} of NVDA (forces a ~$20k borrow)`);
    assert("this buy is within buying power (sanity check on the plan)", targetDollars <= bp, `${targetDollars} vs ${bp}`);
    const buy = await step("re-borrow buy", 25000, () => buyStock(uid, "NVDA", qty));
    assert("re-borrow buy succeeds", !buy.error, buy.error?.message);
    const after = await profileRow(uid);
    console.log(`  new loan: ${money(after.marginLoan)}`);
    assert("a fresh nonzero loan now exists", after.marginLoan > 0, `${after.marginLoan}`);
  }

  console.log("\n████ (6) Warning band fires BEFORE a call ████");
  {
    const p = await profileRow(uid);
    const v = await step("getPositionsValue", 20000, () => getPositionsValue(uid));
    const maintenanceReq = round2(v * MARGIN_MAINTENANCE_PCT);
    const warningCeiling = round2(maintenanceReq * (1 + MARGIN_WARNING_BUFFER_PCT));
    const targetEquity = round2(maintenanceReq * 1.05);
    const forcedLoan = round2(p.cash + v - targetEquity);
    console.log(`  positions_value=${money(v)}, maintenance_req=30%×${money(v)}=${money(maintenanceReq)}, warning_ceiling=×1.10=${money(warningCeiling)}`);
    console.log(`  forcing margin_loan → ${money(forcedLoan)} (via admin_seed_margin_state — see file header) to target equity ${money(targetEquity)}, which sits inside [${money(maintenanceReq)}, ${money(warningCeiling)})`);
    await step("seed margin_loan for warning band", 15000, () => seedMarginState(uid, forcedLoan));

    const summary = await step("runMarginMonitor (expect warning)", 30000, () => runMarginMonitor({ onlyUserId: uid }));
    assert("monitor ran for exactly 1 account", summary.checked === 1, `${summary.checked}`);
    const r = summary.results[0];
    console.log(`  monitor result: previousStatus=${r.previousStatus} → newStatus=${r.newStatus}, equity=${money(r.equity)}, maintenanceReq=${money(r.maintenanceRequirement)}`);
    assert("status transitions 'ok' → 'warning'", r.previousStatus === "ok" && r.newStatus === "warning", `${r.previousStatus} → ${r.newStatus}`);
    assert("NO liquidation occurred (not a call)", !r.liquidated, JSON.stringify(r.liquidated));
    const afterProfile = await profileRow(uid);
    assert("margin_status persisted as 'warning'", afterProfile.marginStatus === "warning");
    const warnEvents = (await marginEvents(uid)).filter((e) => e.kind === "warning");
    assert("'warning' event logged", warnEvents.length === 1, `${warnEvents.length}`);
  }

  console.log("\n████ (5) MARGIN CALL scenario — forced liquidation ████");
  {
    const p = await profileRow(uid);
    const v = await step("getPositionsValue", 20000, () => getPositionsValue(uid));
    const maintenanceReq = round2(v * MARGIN_MAINTENANCE_PCT);
    const targetEquity = round2(maintenanceReq * 0.5);
    const forcedLoan = round2(p.cash + v - targetEquity);
    console.log(`  BEFORE: cash=${money(p.cash)}, positions_value=${money(v)}, maintenance_req=${money(maintenanceReq)}`);
    console.log(`  forcing margin_loan → ${money(forcedLoan)} (via admin_seed_margin_state) to target equity ${money(targetEquity)} (well below maintenance_req, i.e. a genuine call)`);
    await step("seed margin_loan for call", 15000, () => seedMarginState(uid, forcedLoan));
    const holdingBefore = await holdingQty(uid, "NVDA");
    console.log(`  BEFORE: NVDA holding = ${holdingBefore?.quantity} shares`);

    const summary = await step("runMarginMonitor (expect call + liquidation)", 45000, () => runMarginMonitor({ onlyUserId: uid }));
    const r = summary.results[0];
    console.log(`  monitor result: previousStatus=${r.previousStatus}, equity-at-detection=${money(r.equity)}, maintenanceReq=${money(r.maintenanceRequirement)}`);
    assert("a call was detected (calls counter = 1)", summary.calls === 1, `${summary.calls}`);
    assert("exactly one liquidation occurred", summary.liquidations === 1, `${summary.liquidations}`);
    assert("liquidated exactly ONE position: the entire NVDA holding (the only candidate)", !!r.liquidated && r.liquidated.length === 1 && r.liquidated[0].kind === "stock" && r.liquidated[0].symbol === "NVDA" && r.liquidated[0].quantity === holdingBefore?.quantity, JSON.stringify(r.liquidated));
    if (r.liquidated) {
      console.log(`  LIQUIDATED: sold ${r.liquidated[0].quantity} NVDA @ ${money(r.liquidated[0].price ?? 0)} = ${money(r.liquidated[0].proceeds)} proceeds`);
      console.log(`  why this position: it's the SINGLE LARGEST position (and the only one held) — the monitor's documented "largest first, sell entirely" rule`);
    }

    const holdingAfter = await holdingQty(uid, "NVDA");
    assert("NVDA holding fully liquidated (row deleted)", holdingAfter === null, JSON.stringify(holdingAfter));

    const afterProfile = await profileRow(uid);
    const positionsValueAfter = await step("getPositionsValue (post-liquidation)", 20000, () => getPositionsValue(uid));
    const equityAfter = round2(afterProfile.cash + positionsValueAfter - afterProfile.marginLoan);
    const maintenanceReqAfter = round2(positionsValueAfter * MARGIN_MAINTENANCE_PCT);
    console.log(`  AFTER: cash=${money(afterProfile.cash)}, loan=${money(afterProfile.marginLoan)}, positions_value=${money(positionsValueAfter)}`);
    console.log(`  AFTER: equity = ${money(afterProfile.cash)}+${money(positionsValueAfter)}−${money(afterProfile.marginLoan)} = ${money(equityAfter)}, maintenance_req = ${money(maintenanceReqAfter)}`);
    assert("equity restored to/above the (now near-zero) maintenance requirement", equityAfter >= maintenanceReqAfter, `${equityAfter} vs ${maintenanceReqAfter}`);
    assert("final status is 'ok' (fully cleared — no residual loan, no residual position)", afterProfile.marginStatus === "ok" && afterProfile.marginLoan === 0, `status=${afterProfile.marginStatus}, loan=${afterProfile.marginLoan}`);
    assert("monitor's returned newStatus matches the persisted status", r.newStatus === afterProfile.marginStatus);

    const callEvents = (await marginEvents(uid)).filter((e) => e.kind === "call");
    const liqEvents = (await marginEvents(uid)).filter((e) => e.kind === "liquidation");
    assert("'call' event logged", callEvents.length === 1, `${callEvents.length}`);
    assert("'liquidation' event logged, amount = sum of proceeds", liqEvents.length === 1 && !!r.liquidated && closeTo(Number(liqEvents[0].amount), r.liquidated.reduce((s, l) => s + l.proceeds, 0)), JSON.stringify(liqEvents));
  }

  // ════════════════════════════════════════════════════════════════════════
  // (8)+(9) RLS isolation + profiles column-grant fix — second, lightweight user
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n████ (8) RLS isolation of margin_events (second, lightweight user) ████");
  {
    const email2 = `pt-m1-verify-rls-${stamp}@example.org`;
    const created2 = await step("create second test user", 15000, () => admin.auth.admin.createUser({ email: email2, password: PASSWORD, email_confirm: true }));
    if (created2.error || !created2.data.user) throw new Error(`second user creation failed: ${created2.error?.message}`);
    const uid2 = created2.data.user.id;
    console.log(`  second (lightweight) test user: ${email2} (${uid2})`);
    const client2 = createClient(anonUrl, anonKey);
    const signIn2 = await step("sign in second test user", 15000, () => client2.auth.signInWithPassword({ email: email2, password: PASSWORD }));
    if (signIn2.error || !signIn2.data.session) throw new Error(`second sign-in failed: ${signIn2.error?.message}`);

    const ownEvents = await step("primary user reads own margin_events", 15000, () => client.from("margin_events").select("*"));
    assert("primary user's own session sees their OWN events (>0)", !ownEvents.error && (ownEvents.data?.length ?? 0) > 0, `${ownEvents.error?.message} len=${ownEvents.data?.length}`);

    const user2SeesUser1 = await step("user2 tries to read user1's events (filtered)", 15000, () => client2.from("margin_events").select("*").eq("user_id", uid));
    assert("second user's session sees ZERO of the primary user's events (filtered query)", !user2SeesUser1.error && (user2SeesUser1.data?.length ?? 0) === 0, `${user2SeesUser1.error?.message} len=${user2SeesUser1.data?.length}`);

    const user2Own = await step("user2 reads own margin_events", 15000, () => client2.from("margin_events").select("*"));
    assert("second user's own session sees ZERO events (never touched margin)", !user2Own.error && (user2Own.data?.length ?? 0) === 0, `len=${user2Own.data?.length}`);

    const user1Unfiltered = await step("user1 unfiltered select (RLS must still restrict)", 15000, () => client.from("margin_events").select("*"));
    const onlyOwnUser = (user1Unfiltered.data ?? []).every((e) => e.user_id === uid);
    assert("primary user's UNFILTERED select still returns ONLY their own rows (RLS enforced, not app-level filtering)", onlyOwnUser, `saw user_ids: ${[...new Set((user1Unfiltered.data ?? []).map((e) => e.user_id))]}`);

    const directCall = await step("authenticated client tries set_margin_enabled directly (expect denied)", 15000, () => client.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: false }));
    assert("an authenticated (non-service-role) client CANNOT call set_margin_enabled directly (permission denied)", !!directCall.error, directCall.error ? directCall.error.message : "unexpectedly succeeded");
    console.log(`  direct-call error (expected — proves service_role-only EXECUTE): ${directCall.error?.message}`);

    console.log("\n████ (9) profiles column-grant fix ████");
    const dn = await step("authenticated client updates own display_name (expect success)", 15000, () => client2.from("profiles").update({ display_name: "M1 Verify Test" }).eq("id", uid2).select());
    assert("authenticated client CAN update display_name", !dn.error && (dn.data?.length ?? 0) >= 1, dn.error?.message);

    const cashUpd = await step("authenticated client tries updating cash_balance (expect denied)", 15000, () => client2.from("profiles").update({ cash_balance: 999999 }).eq("id", uid2));
    assert("authenticated client REJECTED updating cash_balance directly", !!cashUpd.error, cashUpd.error ? cashUpd.error.message : "unexpectedly succeeded");
    if (cashUpd.error) console.log(`  cash_balance update error (expected): ${cashUpd.error.message}`);

    const loanUpd = await step("authenticated client tries updating margin_loan (expect denied)", 15000, () => client2.from("profiles").update({ margin_loan: 999999 }).eq("id", uid2));
    assert("authenticated client REJECTED updating margin_loan directly", !!loanUpd.error, loanUpd.error ? loanUpd.error.message : "unexpectedly succeeded");
    if (loanUpd.error) console.log(`  margin_loan update error (expected): ${loanUpd.error.message}`);

    const cashCheck = await profileRow(uid2);
    assert("cash_balance actually unchanged in the DB (the rejected update was a true no-op)", cashCheck.cash !== 999999);

    await step("cleanup second user", 15000, async () => {
      await admin.from("margin_events").delete().eq("user_id", uid2);
      await admin.auth.admin.deleteUser(uid2);
    });
  }

  console.log("\n████ Cleanup (primary user) ████");
  await step("cleanup primary user rows + auth user", 20000, async () => {
    await admin.from("margin_events").delete().eq("user_id", uid);
    await admin.from("option_transactions").delete().eq("user_id", uid);
    await admin.from("option_positions").delete().eq("user_id", uid);
    await admin.from("transactions").delete().eq("user_id", uid);
    await admin.from("holdings").delete().eq("user_id", uid);
    await admin.from("portfolio_snapshots").delete().eq("user_id", uid);
    await admin.auth.admin.deleteUser(uid);
  });
  console.log("  test users + all rows deleted.");

  console.log(`\n${failures === 0 ? "ALL M1 MARGIN-ENGINE LIVE CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n💥 SCRIPT ERROR (process WILL exit — never hangs): ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
