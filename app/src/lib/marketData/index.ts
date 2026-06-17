// ════════════════════════════════════════════════════════════════════════
//  marketData — CLIENT-FACING API  (was the Phase 4 stub; now REAL data)
//
//  These functions are how the whole app gets prices/charts. They call
//  TanStack Start server functions (functions.ts), so the actual provider
//  request + API key run SERVER-SIDE ONLY. This module imports NO provider
//  code and NO secret — safe to ship to the browser.
//
//  Note vs Phase 4: these are now ASYNC (live data is inherently async).
//  Call sites fetch via react-query and render loading/empty/error states.
// ════════════════════════════════════════════════════════════════════════

import { getQuotesFn, getCandlesFn, searchSymbolsFn } from "./functions";
import { getStock } from "@/lib/mockData";
import type { Candle, Quote, Range, SymbolMatch } from "./types";

export type { Candle, Quote, Range, SymbolMatch } from "./types";

// Curated universe shown on the Markets page. Kept small to respect the
// Twelve Data free tier (≈8 credits/min). Names/sectors come from curated
// metadata since /quote doesn't return sector. (A provider profile endpoint
// for the full universe is a later enhancement.)
export const MARKET_UNIVERSE = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD"] as const;

// Best-effort sector/name from the curated mock reference table. Market
// reference metadata (names, sectors) is not user data and not a secret.
function enrich(q: Quote): Quote {
  const meta = getStock(q.symbol);
  return {
    ...q,
    name: q.name && q.name !== q.symbol ? q.name : (meta?.name ?? q.name),
    sector: q.sector && q.sector !== "—" ? q.sector : (meta?.sector ?? "—"),
  };
}

/** Live quotes for many symbols, keyed by uppercase symbol. */
export async function getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const list = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const out = new Map<string, Quote>();
  if (list.length === 0) return out;
  const quotes = await getQuotesFn({ data: { symbols: list } });
  for (const q of quotes) out.set(q.symbol, enrich(q));
  return out;
}

/** Live quote for one symbol. */
export async function getQuote(symbol: string): Promise<Quote> {
  const quotes = await getQuotesFn({ data: { symbols: [symbol.toUpperCase()] } });
  return enrich(quotes[0]);
}

/** Historical OHLC candles for a chart range. */
export async function getCandles(symbol: string, range: Range): Promise<Candle[]> {
  return getCandlesFn({ data: { symbol: symbol.toUpperCase(), range } });
}

/** Symbol search (typeahead). */
export async function searchSymbols(query: string): Promise<SymbolMatch[]> {
  if (!query.trim()) return [];
  return searchSymbolsFn({ data: { query } });
}
