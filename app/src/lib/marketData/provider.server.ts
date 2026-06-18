// ════════════════════════════════════════════════════════════════════════
//  Twelve Data PROVIDER ADAPTER (server-only) — HISTORICAL data.
//
//  HYBRID setup (see HANDOFF.md): Twelve Data serves HISTORICAL candles /
//  series (charts + the What-If Simulator). Live quotes, symbol search, and
//  company profiles come from Finnhub (finnhub.server.ts) — Finnhub's free
//  tier has no historical stock candles (premium-only → 403), so history
//  stays here.
//
//  `.server.ts` + use only inside server functions ⇒ the API key and these
//  requests never reach the browser. Shared `num`/`ProviderError` are exported
//  for the sibling Finnhub module.
// ════════════════════════════════════════════════════════════════════════

import { requireServerEnv, serverEnv } from "./env.server";
import type { Candle, Range } from "./types";

const TD_BASE = "https://api.twelvedata.com";

export function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Normalized provider error (used by both Twelve Data and Finnhub adapters). */
export class ProviderError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

// Twelve Data signals errors with `{ status: "error", code, message }`.
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

// Daily candles from a start date up to today, ascending. Used by the
// What-If Simulator (arbitrary historical windows). If start_date predates the
// symbol's listing, Twelve Data returns from the earliest available day — the
// caller treats that first day as "earliest available".
async function tdSeriesSince(symbol: string, startDate: string): Promise<Candle[]> {
  const apikey = requireServerEnv("TWELVEDATA_API_KEY");
  const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=1day&start_date=${startDate}&order=ASC&outputsize=5000&apikey=${apikey}`;
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError(`Provider HTTP ${res.status}`, res.status);
  const json: any = await res.json();
  assertOk(json);
  const values: any[] = Array.isArray(json.values) ? json.values : [];
  return values.map((v) => ({
    t: new Date(v.datetime).toISOString(),
    open: num(v.open),
    high: num(v.high),
    low: num(v.low),
    close: num(v.close),
    volume: num(v.volume),
  }));
}

/** Historical OHLC candles for a chart range (Twelve Data). */
export async function providerCandles(symbol: string, range: Range): Promise<Candle[]> {
  return tdCandles(symbol, range);
}

/** Daily candles from `startDate` (YYYY-MM-DD) to today, ascending (Twelve Data). */
export async function providerSeries(symbol: string, startDate: string): Promise<Candle[]> {
  return tdSeriesSince(symbol, startDate);
}

/** Diagnostics: which provider serves what. */
export function providerInfo() {
  return {
    quotes: serverEnv("FINNHUB_API_KEY") ? "finnhub" : "twelvedata",
    history: "twelvedata",
  };
}
