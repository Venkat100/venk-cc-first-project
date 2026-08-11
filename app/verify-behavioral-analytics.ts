// Throwaway unit test for the BEHAVIOURAL ANALYTICS pure math (vite-node —
// no network, no DB). Every ledger here is synthetic and constructed so the
// answer is known BY CONSTRUCTION, same convention as verify-eventstudy.ts.
//
// For every pattern: one test PLANTS the pattern clearly and proves it's
// detected; another plants a NEUTRAL or OPPOSITE ledger and proves it is
// NOT falsely flagged — false positives are worse than silence here.

import {
  reconstructStockClosingEvents,
  reconstructOptionClosingEvents,
  computeDispositionEffect,
  computeOverTrading,
  computeConcentration,
  computeRevengeTrading,
  computeWinRateVsRiskAdjusted,
  computeJournalCorrelation,
  computeBehavioralAnalytics,
  MIN_CLOSES_PER_BUCKET_DISPOSITION,
  MIN_WEEKS_FOR_FREQUENCY,
  MIN_LOSSES_FOR_REVENGE,
  MIN_CLOSES_FOR_WINRATE,
  MIN_PER_BUCKET_JOURNAL_CORRELATION,
} from "@/lib/behavioral/metrics";
import type { Transaction, OptionTransaction } from "@/lib/supabase/types";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1); // a Thursday
const dateAt = (dayOffset: number) => new Date(EPOCH + dayOffset * DAY_MS).toISOString();

let txnSeq = 0;
function mkTxn(symbol: string, side: "buy" | "sell", quantity: number, price: number, dayOffset: number): Transaction {
  txnSeq++;
  return {
    id: `t${txnSeq}`,
    user_id: "u1",
    symbol,
    side,
    quantity,
    price,
    total: +(quantity * price).toFixed(2),
    order_type: "market",
    status: "filled",
    created_at: dateAt(dayOffset),
  };
}
let optSeq = 0;
function mkOptTxn(contractId: string, symbol: string, side: OptionTransaction["side"], contracts: number, premium: number, dayOffset: number): OptionTransaction {
  optSeq++;
  return {
    id: `o${optSeq}`,
    user_id: "u1",
    contract_id: contractId,
    symbol,
    side,
    contracts,
    premium,
    total: +(contracts * premium * 100).toFixed(2),
    created_at: dateAt(dayOffset),
  };
}

console.log("\n████ 0. Closing-event reconstruction — hand-computed sanity check ████");
{
  // Buy 10 @ $100 (day 0), buy 10 more @ $120 (day 5) -> avg cost = 110.
  // Sell 5 @ $130 (day 10) -> realized on THIS sell: (130-110)*5 = 100, entryPrice=110.
  // Then sell the remaining 15 @ $90 (day 20) -> (90-110)*15 = -300, entryPrice still 110 (sells don't change avg cost).
  const txns = [mkTxn("AAA", "buy", 10, 100, 0), mkTxn("AAA", "buy", 10, 120, 5), mkTxn("AAA", "sell", 5, 130, 10), mkTxn("AAA", "sell", 15, 90, 20)];
  const closes = reconstructStockClosingEvents(txns);
  assert("exactly 2 closing events emitted (2 sells)", closes.length === 2, `got ${closes.length}`);
  const [c1, c2] = closes;
  assert("close #1 entryPrice = weighted avg cost 110 exactly", approx(c1.entryPrice, 110), `got ${c1.entryPrice}`);
  assert("close #1 realizedPnL = (130-110)*5 = 100 exactly", approx(c1.realizedPnL, 100), `got ${c1.realizedPnL}`);
  assert("close #1 holdingDays = from FIRST buy (day 0) to this sell (day 10) = 10", approx(c1.holdingDays, 10), `got ${c1.holdingDays}`);
  assert("close #2 entryPrice UNCHANGED by the first sell — still 110", approx(c2.entryPrice, 110), `got ${c2.entryPrice}`);
  assert("close #2 realizedPnL = (90-110)*15 = -300 exactly", approx(c2.realizedPnL, -300), `got ${c2.realizedPnL}`);
  assert("close #2 relatedTransactionIds includes BOTH buys + this sell", c2.relatedTransactionIds.length === 3);

  // A fresh lineage after fully closing: buy again, confirm openedAt resets.
  const txns2 = [...txns, mkTxn("AAA", "buy", 4, 200, 30), mkTxn("AAA", "sell", 4, 210, 32)];
  const closes2 = reconstructStockClosingEvents(txns2);
  assert("new lineage after full close: 3rd close's entryPrice = 200 (fresh avg cost, not blended with the old 110)", approx(closes2[2].entryPrice, 200), `got ${closes2[2].entryPrice}`);
  assert("new lineage's holdingDays = 2 (from day 30 to day 32), not from the original day 0", approx(closes2[2].holdingDays, 2), `got ${closes2[2].holdingDays}`);
}

console.log("\n████ 1. DISPOSITION EFFECT — planted clearly, then proven absent on a neutral/opposite ledger ████");
{
  // PLANT: 6 winners held 2 days each, 6 losers held 20 days each. Different symbols so lineages don't cross.
  const txns: Transaction[] = [];
  for (let i = 0; i < 6; i++) {
    const sym = `WIN${i}`;
    txns.push(mkTxn(sym, "buy", 10, 100, i * 40));
    txns.push(mkTxn(sym, "sell", 10, 110, i * 40 + 2)); // +10%, held 2 days
  }
  for (let i = 0; i < 6; i++) {
    const sym = `LOSE${i}`;
    txns.push(mkTxn(sym, "buy", 10, 100, i * 40 + 1));
    txns.push(mkTxn(sym, "sell", 10, 90, i * 40 + 21)); // -10%, held 20 days
  }
  const closes = reconstructStockClosingEvents(txns);
  const result = computeDispositionEffect(closes);
  assert("disposition: available once N clears the threshold", result.available === true);
  if (result.available) {
    assert(`disposition: winnersN=${MIN_CLOSES_PER_BUCKET_DISPOSITION}+ (got 6)`, result.data.winnersN === 6);
    assert("disposition: losersN = 6", result.data.losersN === 6);
    assert("disposition: avgHoldDaysWinners = 2 exactly (planted)", approx(result.data.avgHoldDaysWinners, 2), `got ${result.data.avgHoldDaysWinners}`);
    assert("disposition: avgHoldDaysLosers = 20 exactly (planted)", approx(result.data.avgHoldDaysLosers, 20), `got ${result.data.avgHoldDaysLosers}`);
    assert("disposition: soldWinnersFaster = TRUE (the classic disposition-effect signature)", result.data.soldWinnersFaster === true);
  }

  // NEUTRAL/OPPOSITE ledger: winners held LONGER than losers (the healthy pattern) — must NOT be flagged.
  const txnsOpp: Transaction[] = [];
  for (let i = 0; i < 6; i++) {
    const sym = `W2_${i}`;
    txnsOpp.push(mkTxn(sym, "buy", 10, 100, i * 40));
    txnsOpp.push(mkTxn(sym, "sell", 10, 110, i * 40 + 20)); // winner, held 20 days
  }
  for (let i = 0; i < 6; i++) {
    const sym = `L2_${i}`;
    txnsOpp.push(mkTxn(sym, "buy", 10, 100, i * 40 + 1));
    txnsOpp.push(mkTxn(sym, "sell", 10, 90, i * 40 + 3)); // loser, held 2 days
  }
  const closesOpp = reconstructStockClosingEvents(txnsOpp);
  const resultOpp = computeDispositionEffect(closesOpp);
  assert("disposition (opposite ledger): available", resultOpp.available === true);
  if (resultOpp.available) {
    assert("disposition (opposite ledger): soldWinnersFaster = FALSE — no false positive when winners are actually held longer", resultOpp.data.soldWinnersFaster === false);
  }

  // BELOW THRESHOLD: only 2 winners + 2 losers — must be withheld, not shown shakily.
  const tiny = reconstructStockClosingEvents([mkTxn("T1", "buy", 1, 100, 0), mkTxn("T1", "sell", 1, 110, 1), mkTxn("T2", "buy", 1, 100, 0), mkTxn("T2", "sell", 1, 90, 1)]);
  const tinyResult = computeDispositionEffect(tiny);
  assert("disposition: below-threshold sample correctly withheld (available=false)", tinyResult.available === false);
  if (!tinyResult.available) assert("disposition: withheld result states the honest minRequired", tinyResult.minRequired === MIN_CLOSES_PER_BUCKET_DISPOSITION);
}

console.log("\n████ 2. OVER-TRADING — active weeks planted worse, then proven absent on a flat ledger ████");
{
  // 5 "active" weeks (5 trades/week) with poor closes, 5 "quiet" weeks (1 trade/week) with good closes
  // — 5 closes per bucket clears MIN_CLOSES_PER_BUCKET_OVERTRADING exactly.
  const txns: Transaction[] = [];
  let day = 0;
  for (let w = 0; w < 5; w++) {
    // active week: several small round trips, net losing
    for (let i = 0; i < 5; i++) {
      const sym = `A${w}_${i}`;
      txns.push(mkTxn(sym, "buy", 10, 100, day));
      txns.push(mkTxn(sym, "sell", 10, 95, day)); // -5%
    }
    day += 7;
    // quiet week: one good trade
    const sym = `Q${w}`;
    txns.push(mkTxn(sym, "buy", 10, 100, day));
    txns.push(mkTxn(sym, "sell", 10, 108, day)); // +8%
    day += 7;
  }
  const closes = reconstructStockClosingEvents(txns);
  const allTrades = txns.map((t) => ({ date: t.created_at }));
  const result = computeOverTrading(allTrades, closes);
  assert("over-trading: available with 10 weeks of data", result.available === true, JSON.stringify(result));
  if (result.available) {
    assert("over-trading: worseWhenActive = TRUE (planted)", result.data.worseWhenActive === true);
    assert("over-trading: activeWeekAvgReturnPct ≈ -0.05 (planted -5%)", approx(result.data.activeWeekAvgReturnPct, -0.05, 1e-9), `got ${result.data.activeWeekAvgReturnPct}`);
    assert("over-trading: quietWeekAvgReturnPct ≈ 0.08 (planted +8%)", approx(result.data.quietWeekAvgReturnPct, 0.08, 1e-9), `got ${result.data.quietWeekAvgReturnPct}`);
  }

  // BELOW THRESHOLD: only 2 weeks of activity.
  const fewWeeks = computeOverTrading([{ date: dateAt(0) }, { date: dateAt(1) }, { date: dateAt(7) }], []);
  assert("over-trading: below MIN_WEEKS_FOR_FREQUENCY correctly withheld", fewWeeks.available === false && fewWeeks.minRequired === MIN_WEEKS_FOR_FREQUENCY);
}

console.log("\n████ 3. CONCENTRATION — dominant single symbol vs a genuinely diversified ledger ████");
{
  // One symbol at 90% of cost basis, four others splitting the rest.
  const txns = [
    mkTxn("BIG", "buy", 90, 100, 0), // $9,000
    mkTxn("s1", "buy", 25, 10, 1), // $250
    mkTxn("s2", "buy", 25, 10, 1),
    mkTxn("s3", "buy", 25, 10, 1),
    mkTxn("s4", "buy", 25, 10, 1),
  ];
  const result = computeConcentration(txns);
  assert("concentration: available", result.available === true);
  if (result.available) {
    assert("concentration: currentLargestSymbol = BIG", result.data.currentLargestSymbol === "BIG");
    assert("concentration: currentLargestSharePct ≈ 90% ($9000/$10000)", approx(result.data.currentLargestSharePct, 0.9, 1e-6), `got ${result.data.currentLargestSharePct}`);
  }

  // Genuinely diversified, STEADY STATE: 5 equal positions built up (the first few
  // trades are necessarily concentrated while ANY portfolio is being built from
  // scratch — that's an honest fact, not a false positive), then kept in
  // small equal round-robin increments for many more rounds so the startup
  // transient is diluted to a small fraction of the whole history.
  const diversified: Transaction[] = [];
  let dd = 0;
  for (let round = 0; round < 20; round++) {
    for (const sym of ["d1", "d2", "d3", "d4", "d5"]) {
      diversified.push(mkTxn(sym, "buy", 1, 10, dd));
      dd += 1;
    }
  }
  const divResult = computeConcentration(diversified);
  assert("concentration (diversified): available", divResult.available === true);
  if (divResult.available) {
    assert("concentration (diversified): currentLargestSharePct = 20%, well under the threshold", approx(divResult.data.currentLargestSharePct, 0.2, 1e-6), `got ${divResult.data.currentLargestSharePct}`);
    if (divResult.data.historyAvailable) {
      assert(
        "concentration (diversified): pctOfTimeOverThreshold is small — only the honest startup transient, diluted by 95 later balanced trades",
        divResult.data.pctOfTimeOverThreshold !== null && divResult.data.pctOfTimeOverThreshold < 0.1,
        `got ${divResult.data.pctOfTimeOverThreshold}`,
      );
    }
  }
}

console.log("\n████ 4. REVENGE TRADING — sized up after losses, then proven absent when sizing is flat ████");
{
  // 5 losses, each followed by 3 trades roughly 3x the baseline size.
  const txns: Transaction[] = [];
  let day = 0;
  for (let i = 0; i < 5; i++) {
    const sym = `RL${i}`;
    txns.push(mkTxn(sym, "buy", 10, 100, day)); // $1000 baseline-sized loss trade
    txns.push(mkTxn(sym, "sell", 10, 90, day + 1)); // loss
    day += 2;
    for (let j = 0; j < 3; j++) {
      const s2 = `RP${i}_${j}`;
      txns.push(mkTxn(s2, "buy", 30, 100, day)); // $3000 — 3x sized up
      day += 1;
    }
  }
  const closes = reconstructStockClosingEvents(txns);
  const losses = closes.filter((c) => c.realizedPnL < 0);
  // Entry (buy) trades only — matches the module's scoping (see behavioral.ts's
  // comment: mixing in exits would bias the baseline down, since a losing
  // exit's dollar total is mechanically smaller than its matching entry's).
  const entryTrades = txns.filter((t) => t.side === "buy").map((t) => ({ date: t.created_at, totalUSD: t.total }));
  const result = computeRevengeTrading(entryTrades, losses);
  assert("revenge: available", result.available === true, JSON.stringify(result));
  if (result.available) {
    assert("revenge: sizedUpAfterLoss = TRUE (planted 3x)", result.data.sizedUpAfterLoss === true);
    assert("revenge: ratio > 2.5 (planted exactly 3x: post-loss $3000 vs baseline entries $1000)", result.data.ratio > 2.5, `got ${result.data.ratio}`);
  }

  // FLAT ledger: every trade the same size — ratio must be ~1, not flagged.
  const flatTxns: Transaction[] = [];
  let d2 = 0;
  for (let i = 0; i < 5; i++) {
    const sym = `FL${i}`;
    flatTxns.push(mkTxn(sym, "buy", 10, 100, d2));
    flatTxns.push(mkTxn(sym, "sell", 10, 90, d2 + 1));
    d2 += 2;
    for (let j = 0; j < 3; j++) {
      flatTxns.push(mkTxn(`FP${i}_${j}`, "buy", 10, 100, d2));
      d2 += 1;
    }
  }
  const flatCloses = reconstructStockClosingEvents(flatTxns);
  const flatLosses = flatCloses.filter((c) => c.realizedPnL < 0);
  const flatEntryTrades = flatTxns.filter((t) => t.side === "buy").map((t) => ({ date: t.created_at, totalUSD: t.total }));
  const flatResult = computeRevengeTrading(flatEntryTrades, flatLosses);
  assert("revenge (flat sizing): available", flatResult.available === true);
  if (flatResult.available) {
    assert("revenge (flat sizing): sizedUpAfterLoss = FALSE — no false positive when every entry is the same size", flatResult.data.sizedUpAfterLoss === false);
    assert("revenge (flat sizing): ratio = 1 exactly (baseline excludes the post-loss window itself, so no self-dilution)", approx(flatResult.data.ratio, 1, 1e-9), `got ${flatResult.data.ratio}`);
  }

  const fewLosses = computeRevengeTrading([], []);
  assert("revenge: below MIN_LOSSES_FOR_REVENGE correctly withheld", fewLosses.available === false && fewLosses.minRequired === MIN_LOSSES_FOR_REVENGE);
}

console.log("\n████ 5. WIN RATE vs RISK-ADJUSTED RETURN — the exact warning case: high win rate, one huge loss ████");
{
  // 9 small wins (+2% each) + 1 huge loss (-50%) => win rate 90%, but the huge loss should
  // wreck the risk-adjusted figure (high stdev relative to a small positive mean).
  const txns: Transaction[] = [];
  for (let i = 0; i < 9; i++) {
    const sym = `SW${i}`;
    txns.push(mkTxn(sym, "buy", 10, 100, i * 3));
    txns.push(mkTxn(sym, "sell", 10, 102, i * 3 + 1)); // +2%
  }
  txns.push(mkTxn("BIGLOSS", "buy", 10, 100, 30));
  txns.push(mkTxn("BIGLOSS", "sell", 10, 50, 31)); // -50%
  const closes = reconstructStockClosingEvents(txns);
  const result = computeWinRateVsRiskAdjusted(closes);
  assert("winrate: available", result.available === true, JSON.stringify(result));
  if (result.available) {
    assert("winrate: winRate = 0.9 (9 of 10)", approx(result.data.winRate, 0.9, 1e-9), `got ${result.data.winRate}`);
    assert("winrate: warningHighWinRateWeakRiskAdjusted = TRUE — the exact pattern the metric exists to catch", result.data.warningHighWinRateWeakRiskAdjusted === true);
  }

  // HEALTHY case: consistent moderate wins, no blow-up loss — high win rate should NOT trigger the warning.
  const healthyTxns: Transaction[] = [];
  for (let i = 0; i < 10; i++) {
    const sym = `HW${i}`;
    healthyTxns.push(mkTxn(sym, "buy", 10, 100, i * 3));
    healthyTxns.push(mkTxn(sym, "sell", 10, 105, i * 3 + 1)); // +5% every time, zero variance
  }
  const healthyCloses = reconstructStockClosingEvents(healthyTxns);
  const healthyResult = computeWinRateVsRiskAdjusted(healthyCloses);
  assert("winrate (healthy): available", healthyResult.available === true);
  if (healthyResult.available) {
    assert("winrate (healthy): winRate = 1.0", approx(healthyResult.data.winRate, 1, 1e-9));
    assert("winrate (healthy): warning is FALSE — no false positive on a genuinely consistent record", healthyResult.data.warningHighWinRateWeakRiskAdjusted === false);
  }

  const fewCloses = computeWinRateVsRiskAdjusted(closes.slice(0, 3));
  assert("winrate: below MIN_CLOSES_FOR_WINRATE correctly withheld", fewCloses.available === false && fewCloses.minRequired === MIN_CLOSES_FOR_WINRATE);
}

console.log("\n████ 6. JOURNAL CORRELATION — presence-only bucketing, no content ever touched ████");
{
  // 6 noted closes performing better (+10%), 6 unnoted performing worse (-2%).
  const txns: Transaction[] = [];
  const notedIds = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const sym = `NT${i}`;
    const buy = mkTxn(sym, "buy", 10, 100, i * 5);
    const sell = mkTxn(sym, "sell", 10, 110, i * 5 + 2);
    txns.push(buy, sell);
    notedIds.add(buy.id); // presence only — the id, never any text
  }
  for (let i = 0; i < 6; i++) {
    const sym = `UN${i}`;
    txns.push(mkTxn(sym, "buy", 10, 100, 100 + i * 5));
    txns.push(mkTxn(sym, "sell", 10, 98, 100 + i * 5 + 2));
  }
  const closes = reconstructStockClosingEvents(txns);
  const result = computeJournalCorrelation(closes, notedIds, new Set());
  assert("journal-correlation: available", result.available === true, JSON.stringify(result));
  if (result.available) {
    assert("journal-correlation: notedN = 6, unnotedN = 6", result.data.notedN === 6 && result.data.unnotedN === 6);
    assert("journal-correlation: avgReturnPctNoted ≈ +10% (planted)", approx(result.data.avgReturnPctNoted, 0.1, 1e-9), `got ${result.data.avgReturnPctNoted}`);
    assert("journal-correlation: avgReturnPctUnnoted ≈ -2% (planted)", approx(result.data.avgReturnPctUnnoted, -0.02, 1e-9), `got ${result.data.avgReturnPctUnnoted}`);
    assert("journal-correlation: notedPerformedBetter = TRUE", result.data.notedPerformedBetter === true);
  }

  const fewNoted = computeJournalCorrelation(closes, new Set([txns[0].id]), new Set());
  assert("journal-correlation: below MIN_PER_BUCKET withheld", fewNoted.available === false && fewNoted.minRequired === MIN_PER_BUCKET_JOURNAL_CORRELATION);
}

console.log("\n████ 7. OPTIONS — closing reconstruction across buy_to_open / sell_to_close / expired / settled ████");
{
  const c1 = mkOptTxn("AAA-2026-06-19-C-100", "AAA", "buy_to_open", 2, 3.0, 0);
  const c2 = mkOptTxn("AAA-2026-06-19-C-100", "AAA", "sell_to_close", 2, 5.0, 10);
  const closes = reconstructOptionClosingEvents([c1, c2]);
  assert("options: 1 closing event", closes.length === 1);
  assert("options: realizedPnL = (5-3)*100*2 = 400 exactly", approx(closes[0].realizedPnL, 400), `got ${closes[0].realizedPnL}`);
  assert("options: realizedReturnPct = (5-3)/3 (multiplier-free, comparable to stock %)", approx(closes[0].realizedReturnPct, 2 / 3, 1e-9), `got ${closes[0].realizedReturnPct}`);

  const e1 = mkOptTxn("BBB-2026-06-19-P-50", "BBB", "buy_to_open", 1, 2.0, 0);
  const e2 = mkOptTxn("BBB-2026-06-19-P-50", "BBB", "expired", 1, 0, 30);
  const expiredCloses = reconstructOptionClosingEvents([e1, e2]);
  assert("options: expired counts as a close with exitPrice=0", expiredCloses.length === 1 && approx(expiredCloses[0].exitPrice, 0));
  assert("options: expired realizedPnL = -200 exactly (100% loss of premium paid)", approx(expiredCloses[0].realizedPnL, -200), `got ${expiredCloses[0].realizedPnL}`);
}

console.log("\n████ 8. Orchestration — computeBehavioralAnalytics wires everything together ████");
{
  const txns: Transaction[] = [];
  for (let i = 0; i < 8; i++) {
    const sym = `Z${i}`;
    txns.push(mkTxn(sym, "buy", 10, 100, i * 5));
    txns.push(mkTxn(sym, "sell", 10, i % 2 === 0 ? 110 : 90, i * 5 + 2));
  }
  const full = computeBehavioralAnalytics({ transactions: txns, optionTransactions: [], notedTransactionIds: new Set(), notedOptionTransactionIds: new Set() });
  assert("orchestration: returns all 6 metric keys", Object.keys(full).length === 6, JSON.stringify(Object.keys(full)));
  for (const key of ["disposition", "overTrading", "concentration", "revengeTrading", "winRate", "journalCorrelation"] as const) {
    assert(`orchestration: ${key} has an 'available' boolean and an 'n' number`, typeof full[key].n === "number" && typeof full[key].available === "boolean");
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
