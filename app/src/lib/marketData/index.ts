// ════════════════════════════════════════════════════════════════════════
//  marketData — CURRENT-PRICE LOOKUP  ⚠️  PHASE 5 SWAP POINT  ⚠️
// ════════════════════════════════════════════════════════════════════════
//
//  This is the ONLY place the rest of the app asks "what is X worth right
//  now?". Today it returns PLACEHOLDER prices sourced from the static mock
//  table. In Phase 5 this file is replaced so the same functions instead call
//  Supabase Edge Functions (getQuote / getCandles) backed by Finnhub /
//  Twelve Data — WITHOUT changing a single call site.
//
//  Architectural rules this enforces (see CLAUDE.md / ARCHITECTURE.md):
//    • Nothing outside lib/marketData/ may look up a price directly.
//    • No market-data provider (Finnhub etc.) is imported anywhere yet.
//    • When real prices land, only THIS module changes.
//
//  The functions are intentionally synchronous for now (mock data is local).
//  Phase 5 will make them async; call sites already treat the data as
//  "fetched", so the async migration will be mechanical.
// ════════════════════════════════════════════════════════════════════════

import { STOCKS } from "@/lib/mockData";

export type Quote = {
  symbol: string;
  /** Display name, e.g. "Apple Inc." Falls back to the symbol if unknown. */
  name: string;
  /** Sector, e.g. "Technology". "—" if unknown. */
  sector: string;
  /** Latest price (placeholder until Phase 5). */
  price: number;
  /** Absolute change on the day. */
  dayChange: number;
  /** Percent change on the day. */
  dayChangePct: number;
};

function placeholderQuote(symbol: string): Quote {
  const sym = symbol.toUpperCase();
  const s = STOCKS.find((x) => x.symbol === sym);
  if (!s) {
    // Unknown symbol (e.g. a holding for a ticker not in the mock universe).
    // Return a safe zeroed quote so the UI never crashes.
    return { symbol: sym, name: sym, sector: "—", price: 0, dayChange: 0, dayChangePct: 0 };
  }
  return {
    symbol: s.symbol,
    name: s.name,
    sector: s.sector,
    price: s.price,
    dayChange: s.dayChange,
    dayChangePct: s.dayChangePct,
  };
}

/** Current quote for one symbol. */
export function getQuote(symbol: string): Quote {
  return placeholderQuote(symbol);
}

/** Current quotes for many symbols, keyed by uppercase symbol. */
export function getQuotes(symbols: string[]): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const sym of symbols) {
    const q = getQuote(sym);
    out.set(q.symbol, q);
  }
  return out;
}

/** Convenience: just the latest price for a symbol. */
export function getCurrentPrice(symbol: string): number {
  return getQuote(symbol).price;
}
