// TanStack Start server functions — the bridge between the client and the
// server-only provider adapter. The provider import and the API key live only
// inside these handlers, so they are stripped from the client bundle.
//
// Per-symbol quote caching maximizes cache hits across screens (e.g. a holding
// on the dashboard and the same ticker on Markets share one cached quote).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { providerCandles } from "./provider.server";
import { providerQuotes, providerSearch, fhCompanyNews } from "./finnhub.server";
import { durableCached, durablePeekMany, durablePutMany, TTL } from "./cache.server";
import type { Candle, Quote, SymbolMatch, NewsItem } from "./types";

const RANGES = ["1D", "1W", "1M", "3M", "1Y", "ALL"] as const;

export const getQuotesFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ symbols: z.array(z.string().min(1)).min(1).max(50) }))
  .handler(async ({ data }): Promise<Quote[]> => {
    const wanted = data.symbols.map((s) => s.toUpperCase());
    const uniqueWanted = [...new Set(wanted)];

    // L1+L2 peek in one batch (not one L2 round trip per symbol) — the
    // capacity win: a cold invocation still finds symbols another
    // invocation warmed moments ago, via Postgres instead of the provider.
    const result = await durablePeekMany<Quote>("quote", uniqueWanted, "", TTL.quote);
    const missing = uniqueWanted.filter((sym) => !result.has(sym));

    if (missing.length > 0) {
      const fetched = await providerQuotes(missing);
      await durablePutMany(
        "quote",
        "",
        fetched.map((q) => ({ symbol: q.symbol, value: q })),
        TTL.quote,
      );
      for (const q of fetched) result.set(q.symbol, q);
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
    return durableCached("candles", symbol, data.range, TTL.candles, () => providerCandles(symbol, data.range));
  });

export const searchSymbolsFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ query: z.string().min(1) }))
  .handler(async ({ data }): Promise<SymbolMatch[]> => {
    const q = data.query.trim().toLowerCase();
    return durableCached("search", q, "", TTL.search, () => providerSearch(q));
  });

export type CompanyNewsResponse = { ok: true; items: NewsItem[] } | { ok: false; error: string };

/** Recent company news for the Stock Detail news tab. Not user-specific, so
 *  no auth needed (same pattern as quotes/candles/search). Distinguishes a
 *  genuinely-empty result from a provider error/rate-limit, since those need
 *  different UI treatment. */
export const getCompanyNewsFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ symbol: z.string().min(1) }))
  .handler(async ({ data }): Promise<CompanyNewsResponse> => {
    try {
      const items = await fhCompanyNews(data.symbol.toUpperCase(), 7, 10);
      return { ok: true, items };
    } catch {
      return { ok: false, error: "Couldn't load news right now — the provider may be rate-limited. Try again shortly." };
    }
  });
