// Server-side single-quote helper, shared by getQuotesFn and the trading
// engine. Uses the same per-symbol cache keys as functions.ts so a fresh
// quote fetched for a trade also benefits the UI (and vice-versa).

import { providerQuotes } from "./provider.server";
import { cachePeek, cachePut, TTL } from "./cache.server";
import type { Quote } from "./types";

/** Current quote for one symbol, server-side (cached). */
export async function getServerQuote(symbol: string): Promise<Quote> {
  const s = symbol.toUpperCase();
  const hit = cachePeek<Quote>(`quote:${s}`);
  if (hit) return hit;
  const [q] = await providerQuotes([s]);
  if (q) cachePut(`quote:${s}`, q, TTL.quote);
  return q;
}
