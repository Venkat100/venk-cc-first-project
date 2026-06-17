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
