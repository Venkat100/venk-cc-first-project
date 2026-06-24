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
import { cachePeek, cachePut } from "./cache.server";
import { RateLimiter, withRetry, withTimeout } from "./ratelimit.server";
import type { Quote, SymbolMatch } from "./types";

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

type Profile = { name?: string; sector?: string; marketCap?: number; logo?: string; exchange?: string };

async function fhProfile(symbol: string): Promise<Profile> {
  const key = `fh:profile:${symbol}`;
  const hit = cachePeek<Profile>(key);
  if (hit) return hit;
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
    };
  } catch {
    // Profile is best-effort enrichment; never fail a quote because of it.
  }
  cachePut(key, p, PROFILE_TTL);
  return p;
}

async function fh52Week(symbol: string): Promise<{ high?: number; low?: number }> {
  const key = `fh:metric:${symbol}`;
  const hit = cachePeek<{ high?: number; low?: number }>(key);
  if (hit) return hit;
  let out: { high?: number; low?: number } = {};
  try {
    const raw = await fhGet(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`);
    const m = raw?.metric ?? {};
    out = {
      high: m["52WeekHigh"] != null ? num(m["52WeekHigh"]) : undefined,
      low: m["52WeekLow"] != null ? num(m["52WeekLow"]) : undefined,
    };
  } catch {
    // best-effort
  }
  cachePut(key, out, METRIC_TTL);
  return out;
}

// Finnhub's /stock/profile2 is empty for ETFs (no name). Fall back to the
// description from /search for the EXACT symbol so funds show their real name
// (e.g. "Vanguard S&P 500 ETF" instead of "VOO"). Cached so we don't re-search.
async function resolveSymbolName(symbol: string): Promise<string | undefined> {
  const sym = symbol.toUpperCase();
  const key = `fh:name:${sym}`;
  const hit = cachePeek<string>(key);
  if (hit !== undefined) return hit || undefined; // "" cached = searched, no name
  let name: string | undefined;
  try {
    const json = await fhGet(`/search?q=${encodeURIComponent(sym)}`);
    const result: any[] = Array.isArray(json?.result) ? json.result : [];
    const exact = result.find((d) => String(d.symbol).toUpperCase() === sym);
    name = (exact?.description as string) || undefined;
  } catch {
    // best-effort; fall through to symbol
  }
  cachePut(key, name ?? "", PROFILE_TTL);
  return name;
}

async function fhQuote(symbol: string): Promise<Quote> {
  const sym = symbol.toUpperCase();
  // Live quote (cheap) + cached profile/metric enrichment, in parallel.
  const [q, profile, fw] = await Promise.all([
    fhGet(`/quote?symbol=${encodeURIComponent(sym)}`),
    fhProfile(sym),
    fh52Week(sym),
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
    week52High: fw.high,
    week52Low: fw.low,
    marketCap: profile.marketCap,
    logo: profile.logo,
    exchange: profile.exchange,
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
  const key = `fh:metricsfull:${sym}`;
  const hit = cachePeek<SymbolMetrics>(key);
  if (hit) return hit;
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
  cachePut(key, out, METRICS_TTL);
  return out;
}

export type NewsItem = { headline: string; summary?: string; datetime?: number; source?: string };

/** Recent company news (Finnhub /company-news), last `days` days, top `limit`. */
export async function fhCompanyNews(symbol: string, days = 7, limit = 5): Promise<NewsItem[]> {
  const sym = symbol.toUpperCase();
  const key = `fh:news:${sym}`;
  const hit = cachePeek<NewsItem[]>(key);
  if (hit) return hit;
  let out: NewsItem[] = [];
  try {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const json = await fhGet(`/company-news?symbol=${encodeURIComponent(sym)}&from=${fmt(from)}&to=${fmt(to)}`);
    const arr: any[] = Array.isArray(json) ? json : [];
    out = arr
      .filter((n) => n?.headline)
      .slice(0, limit)
      .map((n) => ({ headline: String(n.headline), summary: n.summary ? String(n.summary).slice(0, 280) : undefined, datetime: n.datetime, source: n.source }));
  } catch {
    // best-effort — ETFs and quiet names may have no news
  }
  cachePut(key, out, 60 * 60_000); // 1h
  return out;
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
