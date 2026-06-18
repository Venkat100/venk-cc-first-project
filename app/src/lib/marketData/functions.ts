// TanStack Start server functions — the bridge between the client and the
// server-only provider adapter. The provider import and the API key live only
// inside these handlers, so they are stripped from the client bundle.
//
// Per-symbol quote caching maximizes cache hits across screens (e.g. a holding
// on the dashboard and the same ticker on Markets share one cached quote).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { providerCandles } from "./provider.server";
import { providerQuotes, providerSearch } from "./finnhub.server";
import { cached, cachePeek, cachePut, TTL } from "./cache.server";
import type { Candle, Quote, SymbolMatch } from "./types";

const RANGES = ["1D", "1W", "1M", "3M", "1Y", "ALL"] as const;

export const getQuotesFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ symbols: z.array(z.string().min(1)).min(1).max(50) }))
  .handler(async ({ data }): Promise<Quote[]> => {
    const wanted = data.symbols.map((s) => s.toUpperCase());

    const result = new Map<string, Quote>();
    const missing: string[] = [];
    for (const sym of wanted) {
      const hit = cachePeek<Quote>(`quote:${sym}`);
      if (hit) result.set(sym, hit);
      else if (!missing.includes(sym)) missing.push(sym);
    }

    if (missing.length > 0) {
      const fetched = await providerQuotes(missing);
      for (const q of fetched) {
        cachePut(`quote:${q.symbol}`, q, TTL.quote);
        result.set(q.symbol, q);
      }
    }

    // Preserve request order; guarantee a (zeroed) entry for every symbol.
    return wanted.map(
      (sym) => result.get(sym) ?? { symbol: sym, name: sym, sector: "—", price: 0, dayChange: 0, dayChangePct: 0 },
    );
  });

export const getCandlesFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ symbol: z.string().min(1), range: z.enum(RANGES) }))
  .handler(async ({ data }): Promise<Candle[]> => {
    const symbol = data.symbol.toUpperCase();
    return cached(`candles:${symbol}:${data.range}`, TTL.candles, () => providerCandles(symbol, data.range));
  });

export const searchSymbolsFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ query: z.string().min(1) }))
  .handler(async ({ data }): Promise<SymbolMatch[]> => {
    const q = data.query.trim().toLowerCase();
    return cached(`search:${q}`, TTL.search, () => providerSearch(q));
  });
