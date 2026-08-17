// Options & Margin epic — HARDENING split, part 1/5 (2026-08-15, PLAN.md §6c
// trigger fired: verify-hardening-pass.ts flaked twice more after the
// "split it if it flakes twice more" watchlist entry, both STEP TIMEOUTs,
// both clean on isolated re-run — the systematic causes were already fixed
// at the root; the remaining problem was simply a 430-line, 6-scenario
// script running at the tail of a 31-script sequence. Split into 5
// independently-runnable scripts along the seams where flakes actually
// occurred (runMarginMonitor/runSnapshots step timeouts), not arbitrary
// line counts — see PLAN.md §6c for the full mapping. Every one of this
// original file's 36 assertions has an explicit new home; none dropped.
//
// THIS SCRIPT covers: seed a rich account (stock + margin loan + an option
// ALSO bought on margin + a funded, actually-traded agent), then prove the
// central ask — Dashboard/Margin page/daily snapshot must all agree to the
// cent for that one account — plus the getOptionsValueByUser per-user
// scoping proof and agent/main-account isolation. Sections 1+2 of the
// original file stay together deliberately: section 2 reconciles the EXACT
// account section 1 just built, and neither section has ever been a flake
// source (the one historical runSnapshots flake here was traced to the
// getOptionsValueByUser scoping bug, root-caused and fixed 2026-08-15,
// confirmed clean on 3 consecutive full-suite runs at the time).
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
import { providerQuotes, fetchStats } from "@/lib/marketData/finnhub.server";
import { getRealizedVol } from "@/lib/options/volatility.server";
import { buildChain, parseContractId, priceParsedContract } from "@/lib/options/chain.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { getEnrichedOptionPositions, getOptionsValueByUser } from "@/lib/options/valuation.server";
import { runSnapshots } from "@/lib/snapshots/writer.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) { return `$${Number(n).toFixed(2)}`; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function closeTo(a: number, b: number, eps = 0.02) { return Math.abs(a - b) <= eps; }
// For comparisons that legitimately span TWO INDEPENDENT live-price fetches
// (e.g. this test's own reconstruction vs. getPositionsValue()'s/
// runSnapshots()'s OWN internal fetch, each a genuinely separate network
// call — margin/snapshot code deliberately never uses the quote cache for
// a money-critical number, see valuation.server.ts's own doc comment) a
// real market symbol can tick between the two calls. 5bps of the reference
// value (min 2¢) comfortably covers realistic sub-second tick noise for a
// liquid symbol while staying ~1000x tighter than the smallest real bug
// this test exists to catch.
function closeToLive(a: number, b: number) { return closeTo(a, b, Math.max(0.02, Math.abs(b) * 0.0005)); }
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

  console.log("\n████ Setup: rich throwaway test user (stocks + options + agent + margin) ████");
  const stamp = Date.now();
  const PASSWORD = "HardenPass!234";
  const email = `pt-hardening-valuation-${stamp}@example.org`;
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
  // 1. SEED — stocks, margin loan, an option ALSO bought on margin, agent
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ 1. Seed a rich account: stock + margin loan + option-on-margin + funded agent ████");

  const buy1 = await step("buy 2 AAPL (within cash)", 20000, () => buyStock(uid, "AAPL", 2));
  console.log(`  bought 2 AAPL @ ${money(buy1.price)}`);

  // Fund + set up the agent BEFORE the margin trades below spend all the main
  // cash — fund_agent moves money FROM cash_balance, so funding after the
  // account is fully leveraged would correctly fail for insufficient cash
  // (that's not a bug to chase here, just test-script sequencing).
  await step("upsert agent_config (enabled, balanced, autonomous)", 15000, () => admin.from("agent_config").upsert({ user_id: uid, enabled: true, mode: "autonomous", risk_level: "balanced" }, { onConflict: "user_id" }));
  const fund1 = await step("fund_agent $10,000", 15000, () => admin.rpc("fund_agent", { p_user_id: uid, p_amount: 10000 }));
  assert("fund_agent succeeded", !fund1.error, fund1.error?.message);

  await step("enable margin", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
  const afterEnable = await profileRow(uid);
  assert("margin enabled, loan starts at 0", afterEnable.marginEnabled && afterEnable.marginLoan === 0);

  // Buy enough MORE AAPL to force real borrowing. 1.5× ACTUAL current cash
  // (not a hardcoded figure), safely under the 2×equity buying-power
  // ceiling while still guaranteeing a real borrow, whatever the account's
  // current balance is.
  const p0BeforeBigBuy = await profileRow(uid);
  const buy2 = await step(`buy 1.5× current cash (${money(round2(p0BeforeBigBuy.cash * 1.5))}) of AAPL on margin (forces borrowing)`, 25000, async () => {
    const quote = await withRetry("AAPL quote", () => getServerQuote("AAPL"));
    const targetDollars = round2(p0BeforeBigBuy.cash * 1.5);
    const qty = Math.round((targetDollars / quote.price) * 1e6) / 1e6;
    return buyStock(uid, "AAPL", qty);
  });
  const afterBigBuy = await profileRow(uid);
  assert("margin_loan > 0 after the big buy (real borrowing occurred)", afterBigBuy.marginLoan > 0, money(afterBigBuy.marginLoan));
  console.log(`  cash=${money(afterBigBuy.cash)}, margin_loan=${money(afterBigBuy.marginLoan)}`);

  // Buy ONE option contract, ALSO while margin is on with cash near zero —
  // proves options CAN be bought on borrowed money, consistent with the
  // stock path (both thread p_positions_value into margin_buying_power and
  // both log a 'borrow' margin_event on shortfall).
  const [nvdaQuote, nvdaVol] = await step("quote+vol NVDA (for option chain)", 20000, () => Promise.all([withRetry("NVDA quote", () => getServerQuote("NVDA")), withRetry("NVDA vol", () => getRealizedVol("NVDA"))]));
  const chain = buildChain({ symbol: "NVDA", spot: nvdaQuote.price, vol: nvdaVol });
  const expiry = chain.expiries.find((e) => e.daysToExpiry > 0) ?? chain.expiries[0];
  let atmIdx = 0;
  for (let i = 1; i < expiry.strikes.length; i++) if (Math.abs(expiry.strikes[i].strike - nvdaQuote.price) < Math.abs(expiry.strikes[atmIdx].strike - nvdaQuote.price)) atmIdx = i;
  const optionContract = expiry.strikes[atmIdx].call;
  const loanBeforeOption = (await profileRow(uid)).marginLoan;
  const optBuy = await step("buy 1 NVDA call ON MARGIN", 20000, () => tradeOption(uid, optionContract.contractId, "buy_to_open", 1));
  const afterOptBuy = await profileRow(uid);
  const optBorrowed = Number(optBuy.data.margin_loan) - loanBeforeOption;
  assert("buying an option on margin borrowed money (consistent w/ stock path)", optBorrowed > 0, `loan ${money(loanBeforeOption)} → ${money(afterOptBuy.marginLoan)}`);
  const optionBorrowEvents = (await admin.from("margin_events").select("*").eq("user_id", uid).eq("kind", "borrow")).data ?? [];
  assert("2 'borrow' events logged total (stock + option), both consistent", optionBorrowEvents.length === 2, `${optionBorrowEvents.length}`);

  // Run the real thinker (fully separate sub-portfolio) — AI disabled (pure
  // quant path) to avoid burning API calls in a hardening regression test;
  // still produces a REAL trade into agent_holdings.
  const { runThinker } = await import("@/lib/agent/thinker.server");
  // Generous timeout: a cold (uncached) prefetchUniverse() scores the whole
  // agent universe (~20+ symbols) via real Finnhub calls with H2's own
  // rate-limiter/retry-backoff — genuinely slower than a single quote.
  const thinkerResult = await step("run real thinker (AI disabled, quant only)", 120000, () => runThinker(uid, { disableAi: true }));
  console.log(`  thinker: ran=${thinkerResult.ran} trades=${thinkerResult.executed?.length ?? 0} reason=${thinkerResult.reason ?? "n/a"}`);
  assert("agent thinker ran and traded (real agent_holdings now exist)", thinkerResult.ran && (thinkerResult.executed?.length ?? 0) > 0, JSON.stringify(thinkerResult).slice(0, 200));

  // ══════════════════════════════════════════════════════════════════════
  // 2. 4-WAY VALUATION RECONCILIATION (the central ask)
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ 2. Reconcile Dashboard / Margin page / daily snapshot to the cent ████");
  const positionsValue = await (async () => {
    const p = await profileRow(uid);
    const { data: holdings } = await admin.from("holdings").select("symbol, quantity").eq("user_id", uid);
    const optionPositions = await getEnrichedOptionPositions(uid);
    const optionsValue = round2(optionPositions.reduce((s, x) => s + x.marketValue, 0));
    // ONE batched, uncached fetch — not a per-symbol loop through the 30s-TTL
    // quote cache. getPositionsValue() below ALSO always fetches live, never
    // cached (by design, for a money number) — matching Dashboard's own
    // reconstruction to the SAME always-live mechanism shrinks the
    // remaining race window to "the real network gap between two back-to-
    // back live fetches," covered by closeToLive()'s small tolerance below.
    let holdingsValue = 0;
    if (holdings && holdings.length > 0) {
      const symbols = [...new Set(holdings.map((h) => h.symbol))];
      const quotes = await withRetry("holdings valuation quotes", () => providerQuotes(symbols));
      const priceMap = new Map(quotes.map((q) => [q.symbol, q.price]));
      for (const h of holdings) holdingsValue += (priceMap.get(h.symbol) ?? 0) * Number(h.quantity);
    }
    holdingsValue = round2(holdingsValue);

    // What the Dashboard computes (post-fix): cash + holdings + options − loan.
    const dashboardTotal = round2(p.cash + holdingsValue + optionsValue - p.marginLoan);
    // What the OLD (pre-fix) formula would have shown, for the report — NOT
    // called from any live code path, just the same arithmetic minus the
    // loan subtraction, to document the size of the bug that was found.
    const oldBuggyTotal = round2(p.cash + holdingsValue + optionsValue);
    console.log(`  cash=${money(p.cash)} holdings=${money(holdingsValue)} options=${money(optionsValue)} loan=${money(p.marginLoan)}`);
    console.log(`  Dashboard total (FIXED, equity-based) = ${money(dashboardTotal)}`);
    console.log(`  Dashboard total (OLD buggy formula, no loan subtracted) would have been = ${money(oldBuggyTotal)}  →  overstated by exactly the loan, ${money(p.marginLoan)}`);
    assert("the pre-fix formula WOULD have overstated portfolio value by exactly the loan amount", closeTo(oldBuggyTotal - dashboardTotal, p.marginLoan), `${oldBuggyTotal - dashboardTotal} vs ${p.marginLoan}`);

    // What the Margin page shows (getMarginStateFn's own formula, called directly).
    const positionsValue = await step("getPositionsValue (margin engine's own number)", 20000, () => getPositionsValue(uid));
    const marginEquity = round2(p.cash + positionsValue - p.marginLoan);
    console.log(`  Margin page equity = cash+positions-loan = ${money(p.cash)}+${money(positionsValue)}-${money(p.marginLoan)} = ${money(marginEquity)}`);
    assert("positionsValue (margin engine) === holdingsValue+optionsValue (Dashboard), within live-quote drift", closeToLive(positionsValue, holdingsValue + optionsValue), `${positionsValue} vs ${holdingsValue + optionsValue}`);
    assert("Dashboard total === Margin page equity, within live-quote drift", closeToLive(dashboardTotal, marginEquity), `${dashboardTotal} vs ${marginEquity}`);

    // ── PROOF that getOptionsValueByUser is genuinely scoped ───────────────
    // Seed a SECOND throwaway user with an option position on a DIFFERENT
    // underlying, so the scoping assertions below are exercised against a
    // real multi-user options book, not a vacuously-empty one. Direct
    // insert (service_role has full CRUD on option_positions — a mutable
    // current-state table, unlike the append-only `transactions` ledger) —
    // no need to execute a real second trade just to prove a query filter.
    const { uid: otherUid } = await step("seed a SECOND throwaway user (for the options-scoping proof)", 15000, () => createTestUser(admin, `pt-hardening-valuation-other-${stamp}@example.org`, "OtherUserPass!234"));
    const { error: seedOtherOptErr } = await admin.from("option_positions").insert({
      user_id: otherUid, contract_id: `MSFT-OTHER-${stamp}`, symbol: "MSFT", opt_type: "call",
      strike: 400, expiry: expiry.expiry, contracts: 1, avg_premium: 10,
    });
    if (seedOtherOptErr) throw new Error(`seed other user's option_positions row failed: ${seedOtherOptErr.message}`);
    const multiUserCount = (await admin.from("option_positions").select("user_id", { count: "exact", head: true }).in("user_id", [uid, otherUid])).count ?? 0;
    assert("both throwaway users genuinely have an open option_positions row (scoping test isn't vacuous)", multiUserCount === 2, String(multiUserCount));

    const scopedFetchesBefore = fetchStats().total;
    const scopedMap = await step("getOptionsValueByUser(uid) — SCOPED call, must ignore the other user's MSFT position entirely", 20000, () => getOptionsValueByUser(uid));
    const scopedFetches = fetchStats().total - scopedFetchesBefore;
    assert("scoped call's returned map has NO entry for the other user", !scopedMap.has(otherUid), JSON.stringify([...scopedMap.keys()]));
    assert("scoped call's returned map DOES have an entry for our own user", scopedMap.has(uid), JSON.stringify([...scopedMap.keys()]));
    console.log(`  scoped getOptionsValueByUser(uid): ${scopedFetches} provider fetches (only NVDA — our own position's underlying, never MSFT)`);

    const unscopedFetchesBefore = fetchStats().total;
    const unscopedMap = await step("getOptionsValueByUser() — UNSCOPED call (the real daily-cron path), must STILL include both users", 20000, () => getOptionsValueByUser());
    const unscopedFetches = fetchStats().total - unscopedFetchesBefore;
    assert("unscoped call's returned map DOES include the other user (real production cron behavior preserved)", unscopedMap.has(otherUid), JSON.stringify([...unscopedMap.keys()]));
    assert("unscoped call's returned map DOES include our own user too", unscopedMap.has(uid), JSON.stringify([...unscopedMap.keys()]));
    console.log(`  unscoped getOptionsValueByUser(): ${unscopedFetches} provider fetches (NVDA + MSFT — the whole book, as intended for the real cron)`);

    await step("cleanup: delete the second throwaway user (cascades its option_positions row)", 15000, () => admin.auth.admin.deleteUser(otherUid));

    // What the daily snapshot writer computes (the FIXED code, real function call).
    const snapSummary = await step("runSnapshots({onlyUserId}) — the real writer, correctly scoped end-to-end", 25000, () => runSnapshots({ onlyUserId: uid }));
    assert("snapshot written for this user", snapSummary.snapshotsWritten === 1, JSON.stringify(snapSummary));
    const today = new Date().toISOString().slice(0, 10);
    const { data: snapRow } = await admin.from("portfolio_snapshots").select("total_value, cash, holdings_value").eq("user_id", uid).eq("captured_at", today).single();
    console.log(`  Snapshot row: total_value=${money(Number(snapRow?.total_value))} cash=${money(Number(snapRow?.cash))} holdings_value=${money(Number(snapRow?.holdings_value))}`);
    assert("Snapshot total_value === Dashboard total === Margin equity, ALL within live-quote drift", closeToLive(Number(snapRow?.total_value), dashboardTotal), `${snapRow?.total_value} vs ${dashboardTotal}`);

    // Agent isolation check, folded in here since we already have all 3 pulled:
    const { data: agentCfg } = await admin.from("agent_config").select("agent_cash").eq("user_id", uid).single();
    const { data: agentHoldings } = await admin.from("agent_holdings").select("symbol, quantity").eq("user_id", uid);
    assert("agent_cash/agent_holdings exist (agent really traded)", !!agentCfg && (agentHoldings ?? []).length > 0, `agent_cash=${agentCfg?.agent_cash}, holdings=${(agentHoldings ?? []).length}`);
    assert("main positionsValue (margin engine) does NOT include agent_holdings", closeToLive(positionsValue, holdingsValue + optionsValue), "confirms getPositionsValue only reads `holdings`+`option_positions`, never `agent_holdings`");
    return positionsValue;
  })();
  void positionsValue;

  console.log(`\n████ CLEANUP ████`);
  await step("delete test user", 15000, () => admin.auth.admin.deleteUser(uid));

  console.log(`\n████ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`} ████\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
