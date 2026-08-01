// Shared, DAY-CACHED fetch of ~5Y of daily candles for a symbol — the common
// "long daily history" building block reused by AI Insights' event study
// (lib/insights/eventstudy.server.ts) and the options pricing engine's
// realized-volatility estimator (lib/options/volatility.server.ts).
//
// Caching it HERE (rather than each caller re-fetching its own window) means
// requesting BOTH an AI insight and an options chain for the same symbol on
// the same day costs at most ONE Twelve Data call, not two — event study
// wants the full 5Y span; volatility only needs the trailing ~60 trading
// days, which it slices from the same cached series.

import { providerSeries } from "./provider.server";
import { cached } from "./cache.server";
import type { Candle } from "./types";

const HISTORY_YEARS = 5;
const TTL = 24 * 60 * 60_000; // 1 day — matches the "≤1 fetch/symbol/day" budget

/** ~5Y of ascending daily candles for `symbol`, cached per symbol per day. */
export async function getDailyHistory(symbol: string): Promise<Candle[]> {
  const sym = symbol.toUpperCase();
  const day = new Date().toISOString().slice(0, 10);
  return cached(`daily5y:${sym}:${day}`, TTL, async () => {
    const start = new Date();
    start.setFullYear(start.getFullYear() - HISTORY_YEARS);
    return providerSeries(sym, start.toISOString().slice(0, 10));
  });
}
