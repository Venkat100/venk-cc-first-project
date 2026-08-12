// PLAN.md §6 step 9 (B5) — scenario scoring. Pure: takes plain numbers the
// caller has already fetched (final holdings, final/start prices for every
// curated symbol), returns a fully-reconciled score object. No DB/network
// here — the server function (functions.ts) is responsible for fetching the
// real historical closes and final holdings before calling this.

import type { Scenario } from "./catalog";

export type SymbolReturn = {
  symbol: string;
  startPrice: number;
  endPrice: number;
  returnPct: number; // (end - start) / start
};

export type ScenarioScore = {
  startingCash: number;
  finalCash: number;
  finalHoldingsValue: number;
  finalPortfolioValue: number;
  userReturnPct: number;
  benchmarkReturnPct: number;
  beatBenchmark: boolean;
  perSymbolReturns: SymbolReturn[]; // every curated tradeable symbol, buy-and-hold the whole window
  bestSingleStock: SymbolReturn;
  worstSingleStock: SymbolReturn;
};

export type ComputeScoreInput = {
  scenario: Scenario;
  finalCash: number;
  /** The run's final holdings: symbol -> quantity. */
  finalHoldings: { symbol: string; quantity: number }[];
  /** Close price for every scenario symbol (curated + benchmark) at the
   *  scenario's start date. */
  pricesAtStart: Record<string, number>;
  /** Close price for every scenario symbol (curated + benchmark) at the
   *  scenario's end date (or the run's current date, if scored early). */
  pricesAtEnd: Record<string, number>;
};

export function computeScenarioScore(input: ComputeScoreInput): ScenarioScore {
  const { scenario, finalCash, finalHoldings, pricesAtStart, pricesAtEnd } = input;

  const finalHoldingsValue = finalHoldings.reduce((sum, h) => {
    const price = pricesAtEnd[h.symbol];
    return sum + (price != null ? h.quantity * price : 0);
  }, 0);
  const finalPortfolioValue = finalCash + finalHoldingsValue;
  const userReturnPct = (finalPortfolioValue - scenario.startingCash) / scenario.startingCash;

  const benchStart = pricesAtStart[scenario.benchmarkSymbol];
  const benchEnd = pricesAtEnd[scenario.benchmarkSymbol];
  const benchmarkReturnPct = (benchEnd - benchStart) / benchStart;

  const perSymbolReturns: SymbolReturn[] = scenario.symbols.map((s) => {
    const startPrice = pricesAtStart[s.symbol];
    const endPrice = pricesAtEnd[s.symbol];
    return { symbol: s.symbol, startPrice, endPrice, returnPct: (endPrice - startPrice) / startPrice };
  });

  const best = perSymbolReturns.reduce((a, b) => (b.returnPct > a.returnPct ? b : a));
  const worst = perSymbolReturns.reduce((a, b) => (b.returnPct < a.returnPct ? b : a));

  return {
    startingCash: scenario.startingCash,
    finalCash,
    finalHoldingsValue,
    finalPortfolioValue,
    userReturnPct,
    benchmarkReturnPct,
    beatBenchmark: userReturnPct > benchmarkReturnPct,
    perSymbolReturns,
    bestSingleStock: best,
    worstSingleStock: worst,
  };
}
