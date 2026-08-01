// EVENT STUDY (server-only) — MEASURES how a stock actually behaved after its
// own past "shock" days, instead of relying on an LLM's recollection of
// history. Pure, deterministic math over a chronological daily candle series;
// the only server-only part is the candle fetch (Twelve Data) done by the
// caller — everything in this file is plain arithmetic and independently
// unit-testable against synthetic data.
//
// DEFINITIONS (exact, so results are reproducible):
//   - A "shock" on trading day i is one whose daily return r_i = (close_i -
//     close_{i-1}) / close_{i-1} satisfies |r_i| > SHOCK_STDEV_MULT × σ, where
//     σ is the standard deviation of the TRAILING_WINDOW_DAYS daily returns
//     strictly BEFORE day i (no look-ahead — day i itself and everything after
//     it is excluded from its own threshold).
//   - Direction: r_i > 0 → "up" shock, r_i < 0 → "down" shock.
//   - Forward returns are measured FWD_1W_DAYS / FWD_1M_DAYS TRADING days
//     later (5 / 21 ≈ one calendar week / month of trading days), as
//     (close_{i+k} - close_i) / close_i.
//   - An event only counts if BOTH forward windows are fully realized in the
//     data (i + FWD_1M_DAYS is a real index) — a recent shock with no 1-month
//     future yet does NOT get silently dropped from the 1-week stats while
//     counted in 1-month (which would make the two windows describe different
//     populations); it's excluded from both until it has a full month behind it.

import type { Candle } from "@/lib/marketData/types";
import { getDailyHistory } from "@/lib/marketData/dailyHistory.server";
import type { MeasuredHistory, ShockDirection } from "./types";

export const TRAILING_WINDOW_DAYS = 60;
export const SHOCK_STDEV_MULT = 2;
export const FWD_1W_DAYS = 5;
export const FWD_1M_DAYS = 21;
export const MIN_TRAILING_SAMPLE = 20; // need this many trailing returns before a threshold means anything

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export type ShockEvent = { dayIndex: number; ret: number; fwd1w: number; fwd1m: number };

/** Pure: detect shock events + their realized forward returns from a
 *  chronological array of closing prices. Exported for direct unit testing
 *  with synthetic series where the answer is known by construction. */
export function findShockEvents(closes: number[]): ShockEvent[] {
  const n = closes.length;
  if (n < 2) return [];

  // returns[k] = the return ENDING at closes[k+1], i.e. the return "for" day k+1.
  const returns: number[] = [];
  for (let i = 1; i < n; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);

  const events: ShockEvent[] = [];
  for (let day = 1; day < n; day++) {
    const retIdx = day - 1;
    if (retIdx < MIN_TRAILING_SAMPLE) continue;

    const trailStart = Math.max(0, retIdx - TRAILING_WINDOW_DAYS);
    const trailing = returns.slice(trailStart, retIdx); // strictly before `day` — no look-ahead
    if (trailing.length < MIN_TRAILING_SAMPLE) continue;

    const sigma = stdev(trailing);
    if (sigma <= 0) continue;

    const r = returns[retIdx];
    if (Math.abs(r) <= SHOCK_STDEV_MULT * sigma) continue;

    const i1m = day + FWD_1M_DAYS;
    if (i1m >= n) continue; // full forward month not yet realized in the data
    const i1w = day + FWD_1W_DAYS;

    events.push({
      dayIndex: day,
      ret: r,
      fwd1w: (closes[i1w] - closes[day]) / closes[day],
      fwd1m: (closes[i1m] - closes[day]) / closes[day],
    });
  }
  return events;
}

type Stats = Omit<MeasuredHistory, "direction" | "window_years">;

function summarize(events: ShockEvent[]): Stats {
  if (events.length === 0) {
    return { events_found: 0, avg_fwd_1w: null, median_fwd_1w: null, avg_fwd_1m: null, median_fwd_1m: null, worst_1m: null, best_1m: null, pct_positive_1m: null };
  }
  const fwd1w = events.map((e) => e.fwd1w);
  const fwd1m = events.map((e) => e.fwd1m);
  return {
    events_found: events.length,
    avg_fwd_1w: round4(mean(fwd1w)),
    median_fwd_1w: round4(median(fwd1w)),
    avg_fwd_1m: round4(mean(fwd1m)),
    median_fwd_1m: round4(median(fwd1m)),
    worst_1m: round4(Math.min(...fwd1m)),
    best_1m: round4(Math.max(...fwd1m)),
    pct_positive_1m: round4(fwd1m.filter((x) => x > 0).length / fwd1m.length),
  };
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
function windowYears(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const first = new Date(candles[0].t).getTime();
  const last = new Date(candles[candles.length - 1].t).getTime();
  return Math.round(((last - first) / MS_PER_YEAR) * 10) / 10;
}

/** Compute measured up-shock and down-shock forward-return stats from a
 *  chronological (ascending) daily candle series. Pure — no I/O. */
export function computeEventStudy(candles: Candle[]): { up: MeasuredHistory; down: MeasuredHistory } {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  const years = windowYears(candles);
  const all = findShockEvents(closes);
  const up = all.filter((e) => e.ret > 0);
  const down = all.filter((e) => e.ret < 0);
  return {
    up: { direction: "up", window_years: years, ...summarize(up) },
    down: { direction: "down", window_years: years, ...summarize(down) },
  };
}

// Verification counter: how many times getMeasuredHistory actually ran (i.e.
// not served from getStockInsight's day-cache early-return).
let _calls = 0;
export function measuredHistoryCalls() {
  return _calls;
}
export function resetMeasuredHistoryCalls() {
  _calls = 0;
}

/** Fetch ~5Y of daily history for `symbol` and return the measured stats for
 *  the requested shock `direction`. Candle fetch goes through the shared
 *  getDailyHistory day-cache (see lib/marketData/dailyHistory.server.ts) —
 *  also reused by the options engine's volatility estimator, so requesting
 *  both an insight and an options chain for the same symbol on the same day
 *  costs at most one Twelve Data call. Throws on provider failure; the caller
 *  decides how to degrade (never fabricates numbers). */
export async function getMeasuredHistory(symbol: string, direction: ShockDirection): Promise<MeasuredHistory> {
  _calls++;
  const candles = await getDailyHistory(symbol);
  const { up, down } = computeEventStudy(candles);
  return direction === "up" ? up : down;
}
