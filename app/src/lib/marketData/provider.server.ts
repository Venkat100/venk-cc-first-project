// ════════════════════════════════════════════════════════════════════════
//  Market-data PROVIDER ADAPTER (server-only)
//  The ONLY file in the app that knows about Twelve Data / Finnhub.
//
//  Primary provider: Twelve Data (Venky's key). Finnhub is wired as an
//  optional fallback hook but intentionally kept thin for now.
//
//  `.server.ts` + use only inside server functions ⇒ the API key and these
//  requests never reach the browser.
// ════════════════════════════════════════════════════════════════════════

import { requireServerEnv, serverEnv } from "./env.server";
import type { Candle, Quote, Range, SymbolMatch } from "./types";

const TD_BASE = "https://api.twelvedata.com";

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Twelve Data signals errors with `{ status: "error", code, message }`. */
class ProviderError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

function assertOk(json: any) {
  if (json && json.status === "error") {
    throw new ProviderError(json.message || "Market data provider error", json.code);
  }
}

// ── Range → Twelve Data interval/outputsize ─────────────────────────────
const RANGE_CFG: Record<Range, { interval: string; outputsize: number }> = {
  "1D": { interval: "5min", outputsize: 78 },
  "1W": { interval: "1h", outputsize: 35 },
  "1M": { interval: "1day", outputsize: 22 },
  "3M": { interval: "1day", outputsize: 66 },
  "1Y": { interval: "1day", outputsize: 252 },
  ALL: { interval: "1week", outputsize: 260 },
};

function mapTwelveQuote(raw: any): Quote {
  const price = num(raw.close ?? raw.price);
  const prev = num(raw.previous_close);
  const change = raw.change != null ? num(raw.change) : price - prev;
  const pct = raw.percent_change != null ? num(raw.percent_change) : prev ? (change / prev) * 100 : 0;
  const fwLow = raw.fifty_two_week?.low;
  const fwHigh = raw.fifty_two_week?.high;
  return {
    symbol: String(raw.symbol ?? "").toUpperCase(),
    name: raw.name || String(raw.symbol ?? "").toUpperCase(),
    sector: "—", // not provided by /quote; filled in from curated metadata upstream
    price,
    dayChange: change,
    dayChangePct: pct,
    open: raw.open != null ? num(raw.open) : undefined,
    high: raw.high != null ? num(raw.high) : undefined,
    low: raw.low != null ? num(raw.low) : undefined,
    previousClose: raw.previous_close != null ? prev : undefined,
    volume: raw.volume != null ? num(raw.volume) : undefined,
    week52Low: fwLow != null ? num(fwLow) : undefined,
    week52High: fwHigh != null ? num(fwHigh) : undefined,
  };
}

// ── Twelve Data calls ───────────────────────────────────────────────────
async function tdQuotes(symbols: string[]): Promise<Quote[]> {
  const apikey = requireServerEnv("TWELVEDATA_API_KEY");
  const joined = symbols.map((s) => s.toUpperCase()).join(",");
  const url = `${TD_BASE}/quote?symbol=${encodeURIComponent(joined)}&apikey=${apikey}`;
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError(`Provider HTTP ${res.status}`, res.status);
  const json: any = await res.json();
  assertOk(json);
  // One symbol → a single object; many → an object keyed by symbol.
  if (symbols.length === 1) return [mapTwelveQuote(json)];
  return symbols.map((s) => {
    const raw = json[s.toUpperCase()];
    if (!raw || raw.status === "error") {
      return { symbol: s.toUpperCase(), name: s.toUpperCase(), sector: "—", price: 0, dayChange: 0, dayChangePct: 0 };
    }
    return mapTwelveQuote(raw);
  });
}

async function tdCandles(symbol: string, range: Range): Promise<Candle[]> {
  const apikey = requireServerEnv("TWELVEDATA_API_KEY");
  const { interval, outputsize } = RANGE_CFG[range];
  const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&outputsize=${outputsize}&apikey=${apikey}`;
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError(`Provider HTTP ${res.status}`, res.status);
  const json: any = await res.json();
  assertOk(json);
  const values: any[] = Array.isArray(json.values) ? json.values : [];
  // Twelve Data returns newest-first; charts want chronological order.
  return values
    .map((v) => ({
      t: new Date(v.datetime).toISOString(),
      open: num(v.open),
      high: num(v.high),
      low: num(v.low),
      close: num(v.close),
      volume: num(v.volume),
    }))
    .reverse();
}

async function tdSearch(query: string): Promise<SymbolMatch[]> {
  const apikey = requireServerEnv("TWELVEDATA_API_KEY");
  const url = `${TD_BASE}/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=12&apikey=${apikey}`;
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError(`Provider HTTP ${res.status}`, res.status);
  const json: any = await res.json();
  assertOk(json);
  const data: any[] = Array.isArray(json.data) ? json.data : [];
  return data.map((d) => ({
    symbol: String(d.symbol ?? "").toUpperCase(),
    name: d.instrument_name || d.symbol,
    exchange: d.exchange,
    type: d.instrument_type,
  }));
}

// ── Public adapter (primary → fallback). Keep the fallback thin for now. ──
export async function providerQuotes(symbols: string[]): Promise<Quote[]> {
  return tdQuotes(symbols);
  // Future: if Twelve Data throws a rate-limit/HTTP error and FINNHUB_API_KEY
  // exists, retry via a finnhubQuotes() adapter. Left thin deliberately.
}

export async function providerCandles(symbol: string, range: Range): Promise<Candle[]> {
  return tdCandles(symbol, range);
}

export async function providerSearch(query: string): Promise<SymbolMatch[]> {
  return tdSearch(query);
}

/** Which provider is primary — handy for diagnostics/logging. */
export function primaryProvider(): string {
  return serverEnv("TWELVEDATA_API_KEY") ? "twelvedata" : serverEnv("FINNHUB_API_KEY") ? "finnhub" : "none";
}
