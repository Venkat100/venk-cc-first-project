// Throwaway unit test for the scenario-challenges pure modules (vite-node —
// no network, no DB). Same convention as verify-coaching-pure.ts. Covers
// calendar.ts (the actual no-look-ahead slicing primitive) and scoring.ts.

import { maxStepIndex, cutoffDateForStep, sliceUpToDate, closeOnOrBefore, closeOnExact } from "@/lib/scenarios/calendar";
import { computeScenarioScore } from "@/lib/scenarios/scoring";
import { SCENARIOS, getScenario, listScenarios, scenarioSymbolSet } from "@/lib/scenarios/catalog";
import type { Candle } from "@/lib/marketData/types";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function approx(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

function mkCandle(date: string, close: number): Candle {
  return { t: `${date}T00:00:00.000Z`, open: close, high: close, low: close, close, volume: 1000 };
}

console.log("\n████ 1. catalog.ts — sanity ████");
{
  const all = listScenarios();
  assert("exactly 3 scenarios", all.length === 3, `got ${all.length}`);
  for (const s of all) {
    assert(`${s.id}: symbols within 5-8 curated tickers`, s.symbols.length >= 5 && s.symbols.length <= 8, `got ${s.symbols.length}`);
    assert(`${s.id}: benchmark is SPY`, s.benchmarkSymbol === "SPY");
    assert(`${s.id}: startDate < endDate`, new Date(s.startDate).getTime() < new Date(s.endDate).getTime());
    assert(`${s.id}: startingCash > 0`, s.startingCash > 0);
    assert(`${s.id}: stepTradingDays > 0`, s.stepTradingDays > 0);
    assert(`${s.id}: no duplicate symbols`, new Set(s.symbols.map((x) => x.symbol)).size === s.symbols.length);
    assert(`${s.id}: benchmark not duplicated in tradeable symbols`, !s.symbols.some((x) => x.symbol === s.benchmarkSymbol));
    assert(`${s.id}: has a non-trivial debrief`, s.debrief.length > 200, `len=${s.debrief.length}`);
  }
  assert("getScenario('2008-crisis') resolves", getScenario("2008-crisis")?.id === "2008-crisis");
  assert("getScenario('bogus') returns null", getScenario("bogus") === null);
  const symSet = scenarioSymbolSet(SCENARIOS["2008-crisis"]);
  assert("scenarioSymbolSet includes benchmark", symSet.includes("SPY"));
  assert("scenarioSymbolSet length = tradeable + 1", symSet.length === SCENARIOS["2008-crisis"].symbols.length + 1);
}

console.log("\n████ 2. calendar.ts — the no-look-ahead slicing primitive ████");
{
  const calendar: Candle[] = [
    mkCandle("2020-01-02", 100),
    mkCandle("2020-01-03", 101),
    mkCandle("2020-01-06", 102),
    mkCandle("2020-01-07", 103),
    mkCandle("2020-01-08", 104),
  ];
  assert("maxStepIndex = length-1", maxStepIndex(calendar) === 4);
  assert("maxStepIndex of empty calendar = 0 (floored, never negative)", maxStepIndex([]) === 0);

  assert("cutoffDateForStep(0) = first date", cutoffDateForStep(calendar, 0) === "2020-01-02");
  assert("cutoffDateForStep(2) = third date", cutoffDateForStep(calendar, 2) === "2020-01-06");
  assert("cutoffDateForStep clamps a too-large index to the last date", cutoffDateForStep(calendar, 999) === "2020-01-08");
  assert("cutoffDateForStep clamps a negative index to the first date", cutoffDateForStep(calendar, -5) === "2020-01-02");

  const sliced = sliceUpToDate(calendar, "2020-01-06");
  assert("sliceUpToDate: exactly 3 candles at cutoff 2020-01-06 (THE critical no-look-ahead property)", sliced.length === 3, `got ${sliced.length}`);
  assert("sliceUpToDate: last sliced candle is EXACTLY the cutoff date, nothing after", sliced[sliced.length - 1].t.slice(0, 10) === "2020-01-06");
  assert("sliceUpToDate: no candle beyond the cutoff leaked through", sliced.every((c) => c.t.slice(0, 10) <= "2020-01-06"));

  const otherSymbol: Candle[] = [mkCandle("2020-01-02", 50), mkCandle("2020-01-03", 51), mkCandle("2020-01-08", 55)]; // missing 01-06/01-07 (simulated halt)
  assert("closeOnOrBefore: exact match when present", closeOnOrBefore(otherSymbol, "2020-01-03") === 51);
  assert("closeOnOrBefore: falls back to the latest EARLIER date when the exact date is missing (halt-tolerant)", closeOnOrBefore(otherSymbol, "2020-01-06") === 51);
  assert("closeOnOrBefore: null when cutoff predates all data", closeOnOrBefore(otherSymbol, "2019-12-31") === null);
  assert("closeOnExact: exact match", closeOnExact(otherSymbol, "2020-01-02") === 50);
  assert("closeOnExact: null (not a fallback) when that exact day has no data", closeOnExact(otherSymbol, "2020-01-06") === null);
}

console.log("\n████ 3. scoring.ts — reconciles to the cent, best/worst correctly identified ████");
{
  const scenario = SCENARIOS["2008-crisis"]; // 6 symbols + SPY benchmark
  const pricesAtStart: Record<string, number> = { SPY: 100, AIG: 50, C: 40, BAC: 30, AAPL: 20, WMT: 60, XOM: 80 };
  const pricesAtEnd: Record<string, number> = { SPY: 60 /* -40% */, AIG: 5 /* -90%, worst */, C: 20 /* -50% */, BAC: 25.5 /* -15% */, AAPL: 22 /* +10%, best */, WMT: 63 /* +5% */, XOM: 76 /* -5% */ };

  // User: sold everything into cash except held 100 AAPL the whole way (a good pick), no other positions.
  const score = computeScenarioScore({
    scenario,
    finalCash: 8000, // started with 10,000, spent 2000 on 100 AAPL @ $20
    finalHoldings: [{ symbol: "AAPL", quantity: 100 }],
    pricesAtStart,
    pricesAtEnd,
  });

  assert("finalHoldingsValue = 100 * $22 = $2,200 exactly", approx(score.finalHoldingsValue, 2200), `got ${score.finalHoldingsValue}`);
  assert("finalPortfolioValue = $8,000 cash + $2,200 holdings = $10,200 exactly", approx(score.finalPortfolioValue, 10200), `got ${score.finalPortfolioValue}`);
  assert("userReturnPct = (10200-10000)/10000 = +2% exactly", approx(score.userReturnPct, 0.02), `got ${score.userReturnPct}`);
  assert("benchmarkReturnPct = (60-100)/100 = -40% exactly", approx(score.benchmarkReturnPct, -0.4), `got ${score.benchmarkReturnPct}`);
  assert("beatBenchmark = true (+2% beat -40%)", score.beatBenchmark === true);
  assert("perSymbolReturns has exactly 6 entries (tradeable only, benchmark excluded)", score.perSymbolReturns.length === 6, `got ${score.perSymbolReturns.length}`);
  assert("bestSingleStock = AAPL at +10% exactly", score.bestSingleStock.symbol === "AAPL" && approx(score.bestSingleStock.returnPct, 0.1), JSON.stringify(score.bestSingleStock));
  assert("worstSingleStock = AIG at -90% exactly", score.worstSingleStock.symbol === "AIG" && approx(score.worstSingleStock.returnPct, -0.9), JSON.stringify(score.worstSingleStock));

  // Degenerate case: never traded at all, 100% cash the whole way.
  const cashOnly = computeScenarioScore({ scenario, finalCash: 10_000, finalHoldings: [], pricesAtStart, pricesAtEnd });
  assert("all-cash run: userReturnPct = 0% exactly (nothing gained or lost)", approx(cashOnly.userReturnPct, 0));
  assert("all-cash run: still beats the -40% benchmark", cashOnly.beatBenchmark === true);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
