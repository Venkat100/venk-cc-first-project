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
import type { Quote, SymbolMatch } from "./types";

const FH_BASE = "https://finnhub.io/api/v1";

// Profiles/metrics change slowly — cache them well beyond the 30s quote TTL.
const PROFILE_TTL = 24 * 60 * 60_000; // 24h
const METRIC_TTL = 6 * 60 * 60_000; // 6h

async function fhGet(path: string): Promise<any> {
  const token = requireServerEnv("FINNHUB_API_KEY");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${FH_BASE}${path}${sep}token=${token}`);
  if (res.status === 429) throw new ProviderError("Finnhub rate limit", 429);
  if (!res.ok) throw new ProviderError(`Finnhub HTTP ${res.status}`, res.status);
  const json = await res.json();
  // Finnhub returns {error: "..."} on some failures (e.g. invalid key/symbol).
  if (json && typeof json === "object" && "error" in json && json.error) {
    throw new ProviderError(String(json.error));
  }
  return json;
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
  return {
    symbol: sym,
    name: profile.name || sym,
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
