// PLAN.md §6 step 9 (B5) — the no-look-ahead slicing primitives. Pure:
// operates only on already-fetched Candle[] arrays and plain date strings.
//
// The benchmark symbol's OWN candle series is the scenario's trading-day
// calendar (SPY trades every day the US market is open) — `step_index`
// (0025_scenario_challenges.sql) indexes into that array. Every OTHER
// symbol is sliced by DATE COMPARISON against the calendar's cutoff date,
// not by matching array position — robust to any incidental per-symbol gap
// without needing exact positional alignment across series.

import type { Candle } from "@/lib/marketData/types";

function dateOf(c: Candle): string {
  return c.t.slice(0, 10);
}

/** The last valid step_index for a scenario's calendar (calendar.length - 1,
 *  floored at 0). */
export function maxStepIndex(calendar: Candle[]): number {
  return Math.max(calendar.length - 1, 0);
}

/** The simulated "current date" for a given step_index, clamped into range. */
export function cutoffDateForStep(calendar: Candle[], stepIndex: number): string {
  if (calendar.length === 0) return "";
  const idx = Math.min(Math.max(stepIndex, 0), calendar.length - 1);
  return dateOf(calendar[idx]);
}

/** THE no-look-ahead boundary: every candle with date <= cutoffDate, and
 *  NOTHING past it. This is the array that ever leaves the server. */
export function sliceUpToDate(candles: Candle[], cutoffDate: string): Candle[] {
  return candles.filter((c) => dateOf(c) <= cutoffDate);
}

/** The latest close on or before `cutoffDate` — the price a trade executes
 *  at "today" in the simulation. Null if the symbol has no data that early
 *  (shouldn't happen for a verified scenario symbol, but never silently
 *  fabricate a price). */
export function closeOnOrBefore(candles: Candle[], cutoffDate: string): number | null {
  let best: Candle | null = null;
  for (const c of candles) {
    const d = dateOf(c);
    if (d <= cutoffDate && (!best || d > dateOf(best))) best = c;
  }
  return best ? best.close : null;
}

/** The exact close on `date`, or null if that symbol didn't trade that day. */
export function closeOnExact(candles: Candle[], date: string): number | null {
  const hit = candles.find((c) => dateOf(c) === date);
  return hit ? hit.close : null;
}
