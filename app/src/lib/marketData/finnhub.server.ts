// ════════════════════════════════════════════════════════════════════════
//  Finnhub PROVIDER ADAPTER (server-only) — LIVE data.
//
//  HYBRID setup: Finnhub serves live QUOTES, symbol SEARCH, and company
//  PROFILE (name / sector / market cap / logo). Finnhub free = 60 req/min and
//  includes /quote, /search, /stock/profile2, /stock/metric — but NOT
//  historical stock candles (premium-only), so history stays on Twelve Data.
//
//  Normalizes everything to the shared Quote/SymbolMatch types so nothing
//  downstream changes. `.server.ts` ⇒ key + requests never reach the browser.
// ════════════════════════════════════════════════════════════════════════

import { requireServerEnv } from "./env.server";
import { ProviderError, num } from "./provider.server";
import { durableCached } from "./cache.server";
import { RateLimiter, withRetry, withTimeout } from "./ratelimit.server";
import type { Quote, SymbolMatch, NewsItem, NextEarnings, EarningsSurprise, RecommendationTrendPoint, StockEnrichment } from "./types";

const FH_BASE = "https://finnhub.io/api/v1";

// Profiles/metrics change slowly — cache them well beyond the 30s quote TTL.
const PROFILE_TTL = 24 * 60 * 60_000; // 24h
const METRIC_TTL = 6 * 60 * 60_000; // 6h

// Stay safely under Finnhub's 60 req/min: ≤50 starts per rolling minute, ≤6 in
// flight. A single module-level limiter governs EVERY Finnhub call in the
// process, so a many-agent batch can't blow the cap. Per-call timeout prevents
// a stuck request from hanging an unattended run; 429/5xx/network → retry+backoff.
const FETCH_TIMEOUT_MS = 8_000;
const limiter = new RateLimiter(50, 6);

// Test/telemetry counters: actual network attempts (incl. retries).
let _netFetches = 0;
let _quoteFetches = 0;
export function fetchStats() {
  return { total: _netFetches, quotes: _quoteFetches };
}
export function resetFetchStats() {
  _netFetches = 0;
  _quoteFetches = 0;
}

async function fhGet(path: string): Promise<any> {
  const token = requireServerEnv("FINNHUB_API_KEY");
  const sep = path.includes("?") ? "&" : "?";
  const url = `${FH_BASE}${path}${sep}token=${token}`;
  const isQuote = path.startsWith("/quote");
  return limiter.run(() =>
    withRetry(
      () =>
        withTimeout(async (signal) => {
          _netFetches++;
          if (isQuote) _quoteFetches++;
          const res = await fetch(url, { signal });
          if (res.status === 429) throw new ProviderError("Finnhub rate limit", 429);
          if (!res.ok) throw new ProviderError(`Finnhub HTTP ${res.status}`, res.status);
          const json = await res.json();
          // Finnhub returns {error: "..."} on some failures (e.g. invalid key/symbol).
          if (json && typeof json === "object" && "error" in json && json.error) {
            throw new ProviderError(String(json.error));
          }
          return json;
        }, FETCH_TIMEOUT_MS),
      {
        retries: 3,
        baseMs: 500,
        // Retry rate-limit / server / network / timeout; never retry a 4xx like
        // an invalid symbol (ProviderError with no/!retriable code).
        isRetriable: (e) =>
          e instanceof ProviderError ? e.code === 429 || (e.code ?? 0) >= 500 : true,
      },
    ),
  );
}

type Profile = { name?: string; sector?: string; marketCap?: number; logo?: string; exchange?: string; weburl?: string; country?: string; ipo?: string };

async function fhProfile(symbol: string): Promise<Profile> {
  return durableCached("profile", symbol, "", PROFILE_TTL, async () => {
    let p: Profile = {};
    try {
      const raw = await fhGet(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`);
      p = {
        name: raw?.name || undefined,
        sector: raw?.finnhubIndustry || undefined,
        // Finnhub marketCapitalization is in millions USD.
        marketCap: raw?.marketCapitalization ? num(raw.marketCapitalization) * 1e6 : undefined,
        logo: raw?.logo || undefined,
        exchange: raw?.exchange || undefined,
        // Same response, no extra call — empty for ETFs like everything above.
        weburl: raw?.weburl || undefined,
        country: raw?.country || undefined,
        ipo: raw?.ipo || undefined,
      };
    } catch {
      // Profile is best-effort enrichment; never fail a quote because of it.
    }
    return p;
  });
}

// The Key Stats fields a Stock Detail page can show, extracted from the
// SAME /stock/metric?metric=all call already made here for 52-week
// high/low — zero new API calls (2026-08-13 app audit, Part 4/6). Every
// field is independently optional: ETFs return ~19 of these ~133 possible
// keys (no fundamentals at all, real limitation of the instrument type,
// not a fetch failure), so callers render whichever fields exist and hide
// the rest rather than showing a placeholder for something that
// structurally doesn't apply.
type Fundamentals = {
  high?: number;
  low?: number;
  peTTM?: number;
  epsTTM?: number;
  dividendYieldPct?: number;
  netMarginPct?: number;
  roePct?: number;
  debtToEquity?: number;
  revenueGrowthYoYPct?: number;
  psTTM?: number;
  bookValuePerShare?: number;
  beta?: number;
  priceReturn13wPct?: number;
  priceReturnYtdPct?: number;
};

async function fhFundamentals(symbol: string): Promise<Fundamentals> {
  return durableCached("fundamentals", symbol, "", METRIC_TTL, async () => {
    let out: Fundamentals = {};
    try {
      const raw = await fhGet(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`);
      const m = raw?.metric ?? {};
      const g = (k: string) => (m[k] != null ? num(m[k]) : undefined);
      out = {
        high: g("52WeekHigh"),
        low: g("52WeekLow"),
        peTTM: g("peBasicExclExtraTTM"),
        epsTTM: g("epsBasicExclExtraItemsTTM"),
        dividendYieldPct: g("dividendYieldIndicatedAnnual"),
        netMarginPct: g("netProfitMarginTTM"),
        roePct: g("roeTTM"),
        debtToEquity: g("totalDebt/totalEquityAnnual"),
        revenueGrowthYoYPct: g("revenueGrowthTTMYoy"),
        psTTM: g("psTTM"),
        bookValuePerShare: g("bookValuePerShareAnnual"),
        beta: g("beta"),
        priceReturn13wPct: g("13WeekPriceReturnDaily"),
        priceReturnYtdPct: g("yearToDatePriceReturnDaily"),
      };
    } catch {
      // best-effort
    }
    return out;
  });
}

// Finnhub's /stock/profile2 is empty for ETFs (no name). Fall back to the
// description from /search for the EXACT symbol so funds show their real name
// (e.g. "Vanguard S&P 500 ETF" instead of "VOO"). Cached so we don't re-search.
async function resolveSymbolName(symbol: string): Promise<string | undefined> {
  const sym = symbol.toUpperCase();
  // "" cached = searched, no name — a valid, distinct-from-absent value that
  // durableCached round-trips fine (both tiers key on presence, not truthiness).
  const resolved = await durableCached("name", sym, "", PROFILE_TTL, async () => {
    let name: string | undefined;
    try {
      const json = await fhGet(`/search?q=${encodeURIComponent(sym)}`);
      const result: any[] = Array.isArray(json?.result) ? json.result : [];
      const exact = result.find((d) => String(d.symbol).toUpperCase() === sym);
      name = (exact?.description as string) || undefined;
    } catch {
      // best-effort; fall through to symbol
    }
    return name ?? "";
  });
  return resolved || undefined;
}

async function fhQuote(symbol: string): Promise<Quote> {
  const sym = symbol.toUpperCase();
  // Live quote (cheap) + cached profile/metric enrichment, in parallel.
  const [q, profile, fund] = await Promise.all([
    fhGet(`/quote?symbol=${encodeURIComponent(sym)}`),
    fhProfile(sym),
    fhFundamentals(sym),
  ]);
  const price = num(q?.c);
  const change = num(q?.d);
  const pct = num(q?.dp);
  // Profile name first (stocks); for ETFs/others with no profile name, resolve
  // from symbol search; finally fall back to the bare ticker.
  const resolvedName = profile.name || (await resolveSymbolName(sym)) || sym;
  return {
    symbol: sym,
    name: resolvedName,
    sector: profile.sector || "—",
    price,
    dayChange: change,
    dayChangePct: pct,
    open: q?.o != null ? num(q.o) : undefined,
    high: q?.h != null ? num(q.h) : undefined,
    low: q?.l != null ? num(q.l) : undefined,
    previousClose: q?.pc != null ? num(q.pc) : undefined,
    volume: undefined, // Finnhub /quote has no intraday volume on free tier
    week52High: fund.high,
    week52Low: fund.low,
    marketCap: profile.marketCap,
    logo: profile.logo,
    exchange: profile.exchange,
    weburl: profile.weburl,
    country: profile.country,
    ipo: profile.ipo,
    peTTM: fund.peTTM,
    epsTTM: fund.epsTTM,
    dividendYieldPct: fund.dividendYieldPct,
    netMarginPct: fund.netMarginPct,
    roePct: fund.roePct,
    debtToEquity: fund.debtToEquity,
    revenueGrowthYoYPct: fund.revenueGrowthYoYPct,
    psTTM: fund.psTTM,
    bookValuePerShare: fund.bookValuePerShare,
    beta: fund.beta,
    priceReturn13wPct: fund.priceReturn13wPct,
    priceReturnYtdPct: fund.priceReturnYtdPct,
  };
}

/** Live quotes for many symbols (Finnhub). One /quote call per symbol. */
export async function providerQuotes(symbols: string[]): Promise<Quote[]> {
  const list = symbols.map((s) => s.toUpperCase());
  const results = await Promise.allSettled(list.map((s) => fhQuote(s)));
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { symbol: list[i], name: list[i], sector: "—", price: 0, dayChange: 0, dayChangePct: 0 },
  );
}

// ── Fundamentals / metrics (for the AI agent's quant layer) ─────────────
export type SymbolMetrics = {
  symbol: string;
  week52High?: number;
  week52Low?: number;
  beta?: number; // volatility proxy
  return4w?: number; // % price return, 4 weeks
  return13w?: number; // % price return, 13 weeks
  return26w?: number; // % price return, 26 weeks
  return52w?: number; // % price return, 52 weeks
};

const METRICS_TTL = 6 * 60 * 60_000; // 6h

/** Basic financials / momentum metrics for a symbol (Finnhub /stock/metric). */
export async function fhMetrics(symbol: string): Promise<SymbolMetrics> {
  const sym = symbol.toUpperCase();
  return durableCached("metricsfull", sym, "", METRICS_TTL, async () => {
    let out: SymbolMetrics = { symbol: sym };
    try {
      const raw = await fhGet(`/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`);
      const m = raw?.metric ?? {};
      const g = (k: string) => (m[k] != null ? num(m[k]) : undefined);
      out = {
        symbol: sym,
        week52High: g("52WeekHigh"),
        week52Low: g("52WeekLow"),
        beta: g("beta"),
        return4w: g("4WeekPriceReturnDaily") ?? g("monthToDatePriceReturnDaily"),
        return13w: g("13WeekPriceReturnDaily"),
        return26w: g("26WeekPriceReturnDaily"),
        return52w: g("52WeekPriceReturnDaily"),
      };
    } catch {
      // best-effort — quant degrades gracefully if metrics are missing
    }
    return out;
  });
}

/** Recent company news (Finnhub /company-news), last `days` days, top `limit`.
 *  Errors PROPAGATE (unlike most best-effort enrichment here) so callers that
 *  need to tell "genuinely no news" apart from "provider error/rate-limited"
 *  can — e.g. the News tab. Existing callers that just want best-effort
 *  already wrap this in `.catch(() => [])`. */
export async function fhCompanyNews(symbol: string, days = 7, limit = 5): Promise<NewsItem[]> {
  const sym = symbol.toUpperCase();
  // Note: `fn` here can THROW (unlike the best-effort helpers above) — that's
  // deliberate (see the file-header note on this function) and durableCached
  // preserves it exactly: an error propagates without writing L1 or L2, so a
  // rate-limited/failed fetch never gets cached as "no news".
  return durableCached("news", sym, String(limit), 60 * 60_000, async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const json = await fhGet(`/company-news?symbol=${encodeURIComponent(sym)}&from=${fmt(from)}&to=${fmt(to)}`);
    const arr: any[] = Array.isArray(json) ? json : [];
    const out: NewsItem[] = arr
      .filter((n) => n?.headline)
      .slice(0, limit)
      .map((n) => ({
        headline: String(n.headline),
        summary: n.summary ? String(n.summary).slice(0, 280) : undefined,
        datetime: n.datetime,
        source: n.source,
        url: n.url ? String(n.url) : undefined,
      }));
    return out;
  });
}

/** Symbol search (Finnhub /search). */
export async function providerSearch(query: string): Promise<SymbolMatch[]> {
  const json = await fhGet(`/search?q=${encodeURIComponent(query)}`);
  const result: any[] = Array.isArray(json?.result) ? json.result : [];
  return result
    .filter((d) => d.symbol && !d.symbol.includes(".")) // skip foreign-listing dupes
    .slice(0, 12)
    .map((d) => ({
      symbol: String(d.symbol).toUpperCase(),
      name: d.description || d.symbol,
      type: d.type,
    }));
}

// ── Stock page enrichment, phase 2 (2026-08-14) ──────────────────────────
// PLAN.md app audit follow-up: a live probe of our EXISTING free Finnhub
// key (no plan change) against 13 candidate endpoints across a mega-cap,
// an ETF, and a mid-cap found 6 genuinely accessible on the free tier —
// see AUDIT.md's stock-page-enrichment section for the full probe table.
// Building 4 of the 6 here: next earnings date, EPS surprise history,
// analyst recommendation trend, and peer tickers. DELIBERATELY SKIPPING
// insider sentiment (MSPR) and insider transactions, though both are
// free and accessible: they're advanced signals novices routinely
// misread (an insider sale is usually scheduled 10b5-1 vesting, not a
// bearish signal), and in a teaching product surfacing them without real
// explanatory context invites exactly the wrong inference. Revisit later
// WITH education attached, not before — not a technical limitation, a
// deliberate one.
//
// All four are near-static (earnings dates/estimates, a quarter's actual
// results, analyst opinion counts, and peer lists all change at most
// once a day, usually far less) — cached for 24h, same durableCached
// two-tier path as everything else in this file, same "genuinely empty
// for ETFs, not an error" contract as fhFundamentals above.
const ENRICHMENT_TTL = 24 * 60 * 60_000; // 24h

async function fhNextEarnings(symbol: string): Promise<NextEarnings | undefined> {
  // durableCached's L2 tier is a Postgres `payload jsonb NOT NULL` column,
  // written via the Supabase client — a JS `null` (tried first, and JS
  // `undefined` before that) both map to SQL NULL on that insert, not the
  // valid JSON scalar `null`, so both failed the NOT NULL constraint the
  // exact same way (confirmed live both times: "[price_cache] L2 write
  // failed ... null value in column payload"). The durable half of the
  // cache was silently never persisting the ETF case — every cold start
  // would re-hit Finnhub for it. Fix: the OUTER cached value is always a
  // real, non-null object (`{ earnings: ... }`); only the INNER field is
  // ever null, which is fine — a JSON null nested inside a non-null jsonb
  // object is a completely different thing from the column itself being
  // SQL NULL. Unwrapped back to plain `NextEarnings | undefined` at the
  // public return, matching this field's convention everywhere else.
  // Cache kind renamed from "earningsCalendar" (this dev session's own
  // stale rows, written under the broken pre-wrapper shape while chasing
  // this exact bug, would otherwise shadow the fix for a full ENRICHMENT_TTL —
  // just a namespace string, safe to rename, old rows age out naturally).
  const cached = await durableCached("nextEarnings", symbol, "", ENRICHMENT_TTL, async (): Promise<{ earnings: NextEarnings | null }> => {
    try {
      const from = new Date();
      const to = new Date(from.getTime() + 240 * 86_400_000); // ~8 months — comfortably spans one quarterly cycle even right after a print
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const raw = await fhGet(`/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}`);
      const rows: any[] = Array.isArray(raw?.earningsCalendar) ? raw.earningsCalendar : [];
      if (rows.length === 0) return { earnings: null }; // ETFs, or nothing scheduled in the window
      const todayStr = fmt(from);
      const upcoming = rows.filter((r) => typeof r?.date === "string" && r.date >= todayStr).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const next = upcoming[0] ?? rows[0];
      if (!next?.date) return { earnings: null };
      return {
        earnings: {
          date: String(next.date),
          hour: next.hour ? String(next.hour) : undefined,
          epsEstimate: next.epsEstimate != null ? num(next.epsEstimate) : undefined,
          revenueEstimate: next.revenueEstimate != null ? num(next.revenueEstimate) : undefined,
        },
      };
    } catch {
      return { earnings: null }; // best-effort
    }
  });
  return cached.earnings ?? undefined;
}

async function fhEarningsSurprises(symbol: string): Promise<EarningsSurprise[]> {
  return durableCached("earningsSurprises", symbol, "", ENRICHMENT_TTL, async () => {
    try {
      const raw = await fhGet(`/stock/earnings?symbol=${encodeURIComponent(symbol)}`);
      const rows: any[] = Array.isArray(raw) ? raw : [];
      return rows
        .filter((r) => r?.period)
        .sort((a, b) => String(b.period).localeCompare(String(a.period))) // newest first, don't trust provider order
        .slice(0, 4)
        .map((r) => ({
          period: String(r.period),
          quarter: r.quarter != null ? num(r.quarter) : undefined,
          year: r.year != null ? num(r.year) : undefined,
          estimate: r.estimate != null ? num(r.estimate) : undefined,
          actual: r.actual != null ? num(r.actual) : undefined,
          surprisePercent: r.surprisePercent != null ? num(r.surprisePercent) : undefined,
        }));
    } catch {
      return []; // best-effort — empty is also the genuine ETF shape
    }
  });
}

async function fhRecommendationTrend(symbol: string): Promise<RecommendationTrendPoint[]> {
  return durableCached("recommendationTrend", symbol, "", ENRICHMENT_TTL, async () => {
    try {
      const raw = await fhGet(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`);
      const rows: any[] = Array.isArray(raw) ? raw : [];
      return rows
        .filter((r) => r?.period)
        .sort((a, b) => String(b.period).localeCompare(String(a.period))) // newest first
        .slice(0, 4)
        .map((r) => ({
          period: String(r.period),
          strongBuy: num(r.strongBuy ?? 0),
          buy: num(r.buy ?? 0),
          hold: num(r.hold ?? 0),
          sell: num(r.sell ?? 0),
          strongSell: num(r.strongSell ?? 0),
        }));
    } catch {
      return [];
    }
  });
}

async function fhPeers(symbol: string): Promise<string[]> {
  const sym = symbol.toUpperCase();
  return durableCached("peers", sym, "", ENRICHMENT_TTL, async () => {
    try {
      const raw = await fhGet(`/stock/peers?symbol=${encodeURIComponent(sym)}`);
      const rows: string[] = Array.isArray(raw) ? raw.map((s) => String(s).toUpperCase()) : [];
      // Finnhub includes the requested symbol itself in the list — exclude it,
      // dedupe, and cap to a sensible "related stocks" row length.
      return [...new Set(rows.filter((s) => s && s !== sym))].slice(0, 6);
    } catch {
      return [];
    }
  });
}

/** All 4 phase-2 enrichment datasets for one symbol, fetched in parallel —
 *  each independently cached (24h), each independently best-effort, so one
 *  failing/empty field never blocks the other three. */
export async function fhStockEnrichment(symbol: string): Promise<StockEnrichment> {
  const sym = symbol.toUpperCase();
  const [nextEarnings, earningsSurprises, recommendationTrend, peers] = await Promise.all([
    fhNextEarnings(sym),
    fhEarningsSurprises(sym),
    fhRecommendationTrend(sym),
    fhPeers(sym),
  ]);
  return { nextEarnings, earningsSurprises, recommendationTrend, peers };
}
