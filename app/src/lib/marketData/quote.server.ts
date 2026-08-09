// Server-side single-quote helper, shared by getQuotesFn and the trading
// engine. Uses the same per-symbol cache keys as functions.ts so a fresh
// quote fetched for a trade also benefits the UI (and vice-versa).

import { providerQuotes } from "./finnhub.server";
import { durableCached, TTL } from "./cache.server";
import type { Quote } from "./types";

/** Current quote for one symbol, server-side (cached). Same kind/interval
 *  as getQuotesFn's batch path, so both share one L1+L2 cache entry per
 *  symbol regardless of which path warms it first. */
export async function getServerQuote(symbol: string): Promise<Quote> {
  const s = symbol.toUpperCase();
  return durableCached("quote", s, "", TTL.quote, async () => {
    const [q] = await providerQuotes([s]);
    return q;
  });
}
