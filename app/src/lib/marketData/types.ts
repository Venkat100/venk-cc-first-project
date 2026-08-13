// Shared, provider-agnostic market-data types. These are the ONLY shapes the
// rest of the app sees — no Finnhub/Twelve Data shapes leak past lib/marketData.

export type Range = "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";

export type Quote = {
  symbol: string;
  /** Company/display name. Falls back to the symbol if the provider omits it. */
  name: string;
  /** Sector — provider quotes rarely include this, so it's best-effort ("—"). */
  sector: string;
  price: number;
  dayChange: number;
  dayChangePct: number;
  // Extra stats (used on Stock Detail). Optional — providers vary.
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  volume?: number;
  week52High?: number;
  week52Low?: number;
  // Company profile (from Finnhub /stock/profile2 + /stock/metric).
  marketCap?: number; // absolute USD
  logo?: string;
  exchange?: string;
  // Extra profile fields (same /stock/profile2 call, no extra cost). Empty
  // for ETFs/funds, where Finnhub's profile has no data at all.
  weburl?: string;
  country?: string;
  ipo?: string; // YYYY-MM-DD
  // Fundamentals — same /stock/metric?metric=all call already made for
  // week52High/Low (PLAN.md app audit, 2026-08-13: this response was being
  // fetched and almost entirely discarded). Genuinely absent (not merely
  // zero) for ETFs/funds, which have no per-share earnings or debt
  // structure of their own — callers must treat `undefined` as "doesn't
  // apply to this instrument," not as a loading/error state.
  peTTM?: number;
  epsTTM?: number;
  dividendYieldPct?: number;
  netMarginPct?: number; // can be negative for unprofitable companies — a real number, not an error
  roePct?: number;
  debtToEquity?: number;
  revenueGrowthYoYPct?: number;
  psTTM?: number;
  bookValuePerShare?: number;
  // Populated for instruments that lack the fundamentals above (ETFs) as a
  // meaningful substitute — always present when the metric call succeeds,
  // for stocks and funds alike.
  beta?: number;
  priceReturn13wPct?: number;
  priceReturnYtdPct?: number;
};

export type Candle = {
  /** ISO timestamp. */
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SymbolMatch = {
  symbol: string;
  name: string;
  exchange?: string;
  type?: string;
};

export type NewsItem = {
  headline: string;
  summary?: string;
  /** Unix seconds. */
  datetime?: number;
  source?: string;
  /** Link to the original article. Absent → render as plain text, not a dead link. */
  url?: string;
};
