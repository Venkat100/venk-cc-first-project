// Realized-volatility estimator (server-only — the fetch is; the math is
// pure) — the σ input to the Black-Scholes pricing engine.
//
// HONESTY NOTE (disclosed to users at O3, not hidden): Black-Scholes wants a
// forward-looking IMPLIED volatility (what the options market currently
// prices in). Free data tiers give us no options market to read that from —
// so we use REALIZED volatility (how much the stock has actually moved
// recently) as an honest, disclosed proxy. It's not the same number a real
// broker would show, but it's a real, live-data-derived estimate, not a
// made-up constant.
//
// DEFINITION: annualized standard deviation of daily LOG returns over the
// trailing `VOL_WINDOW_DAYS` trading days, annualized by √(TRADING_DAYS_PER_YEAR).
// Log returns (not simple returns) because they're the standard choice for
// volatility estimation — additive over time and symmetric for up/down moves.

import { getDailyHistory } from "@/lib/marketData/dailyHistory.server";
import type { Candle } from "@/lib/marketData/types";

const TRADING_DAYS_PER_YEAR = 252;
const VOL_WINDOW_DAYS = 60;

// Clamp band: a real 60-day realized vol essentially never goes below ~10%
// even for the calmest large caps/ETFs, and the ceiling bounds a single wild
// stretch (a meme-stock spike, an earnings-week outlier) from producing
// implausible premiums. Both ends are a deliberate, documented simplification
// — a refinement lever, not a physical law.
export const MIN_VOL = 0.1;
export const MAX_VOL = 1.5;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** PURE: annualized realized volatility from a chronological (ascending)
 *  daily candle series. Short/degenerate history (< 2 usable closes, or
 *  fewer than 2 returns in the trailing window) honestly falls back to the
 *  MIN_VOL floor rather than dividing by zero or returning NaN — a recent
 *  IPO with almost no price history gets a conservative default, not a
 *  crash. Exported standalone so it's independently unit-testable against a
 *  synthetic series with a known stdev. */
export function computeRealizedVol(candles: Candle[], windowDays: number = VOL_WINDOW_DAYS): number {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  if (closes.length < 2) return MIN_VOL;

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) logReturns.push(Math.log(closes[i] / closes[i - 1]));

  const tail = logReturns.slice(-windowDays);
  if (tail.length < 2) return MIN_VOL;

  const dailySigma = stdev(tail);
  const annualized = dailySigma * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return Math.min(MAX_VOL, Math.max(MIN_VOL, annualized));
}

/** Fetch + compute for a live symbol. Goes through the shared
 *  getDailyHistory day-cache (see lib/marketData/dailyHistory.server.ts),
 *  so it costs a fresh Twelve Data call at most once per symbol per day —
 *  and reuses the SAME cached series the AI Insights event study fetches,
 *  if both were requested for the same symbol on the same day. */
export async function getRealizedVol(symbol: string): Promise<number> {
  const candles = await getDailyHistory(symbol);
  return computeRealizedVol(candles);
}
