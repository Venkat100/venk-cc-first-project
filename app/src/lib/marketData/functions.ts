// TanStack Start server functions — the bridge between the client and the
// server-only provider adapter. The provider import and the API key live only
// inside these handlers, so they are stripped from the client bundle.
//
// Per-symbol quote caching maximizes cache hits across screens (e.g. a holding
// on the dashboard and the same ticker on Markets share one cached quote).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { providerCandles } from "./provider.server";
import { providerQuotes, providerSearch, fhCompanyNews, fhStockEnrichment } from "./finnhub.server";
import { durableCached, durablePeekMany, durablePutMany, TTL } from "./cache.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import type { Candle, Quote, SymbolMatch, NewsItem, StockEnrichment } from "./types";

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

export type StockEnrichmentResponse = { ok: true; data: StockEnrichment } | { ok: false; error: string };

/** Stock page enrichment, phase 2 (2026-08-14): next earnings date, EPS
 *  surprise history, analyst recommendation trend, peer tickers. Not
 *  user-specific — same no-auth pattern as quotes/candles/search/news.
 *  One round trip for all four; each is independently cached/best-effort
 *  server-side (see fhStockEnrichment), so this can never partially fail —
 *  worst case a field comes back empty and the UI hides that section. */
export const getStockEnrichmentFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ symbol: z.string().min(1) }))
  .handler(async ({ data }): Promise<StockEnrichmentResponse> => {
    try {
      const enrichment = await fhStockEnrichment(data.symbol.toUpperCase());
      return { ok: true, data: enrichment };
    } catch {
      return { ok: false, error: "Couldn't load earnings/analyst data right now. Try again shortly." };
    }
  });

// AUDIT.md Part 6(b) item 7 (2026-08-14 Tier-2 fix pass) — a small "News" /
// "AI take" indicator on Markets/Watchlist rows, for the exact symbols we
// can PROVE already have content ready to view. Deliberately NOT a fetch:
// both reads are against tables this app already writes to as a SIDE
// EFFECT of normal traffic — price_cache (news is durably cached there,
// see fhCompanyNews/durableCached in finnhub.server.ts) and insights
// (written once per symbol per day the first time anyone requests it, see
// insights.server.ts). Zero Finnhub/Twelve Data/Anthropic calls here, ever
// — this can only ever say "yes, definitely" or "not that we know of,"
// never fabricate availability for a symbol nobody has touched yet.
export type ContentAvailability = { newsSymbols: string[]; insightSymbols: string[] };
const NEWS_FRESHNESS_MS = 24 * 60 * 60_000; // matches the file-header note in pruneCache.server.ts: nothing is ever READ past ~24h of staleness anyway, so this is the natural "is it still relevant" cutoff, not an arbitrary new number.

export const getContentAvailabilityFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ symbols: z.array(z.string().min(1)).min(1).max(100) }))
  .handler(async ({ data }): Promise<ContentAvailability> => {
    const symbols = [...new Set(data.symbols.map((s) => s.toUpperCase()))];
    const admin = getServiceClient();
    const today = new Date().toISOString().slice(0, 10);
    const newsCutoff = new Date(Date.now() - NEWS_FRESHNESS_MS).toISOString();

    const [newsRes, insightRes] = await Promise.all([
      admin.from("price_cache").select("symbol").eq("kind", "news").in("symbol", symbols).gte("fetched_at", newsCutoff),
      admin.from("insights").select("symbol").eq("kind", "stock").eq("created_at", today).in("symbol", symbols),
    ]);

    return {
      newsSymbols: [...new Set((newsRes.data ?? []).map((r) => r.symbol as string))],
      insightSymbols: [...new Set((insightRes.data ?? []).map((r) => r.symbol as string))],
    };
  });
