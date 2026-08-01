// Shared AI-Insights types (client + server safe — no server imports).

export type InsightLean = "bullish" | "bearish" | "neutral";
export type InsightConfidence = "low" | "moderate" | "high";

export type ShockDirection = "up" | "down";

/** EVENT STUDY output — MEASURED (not LLM-recalled) stats on how this stock
 *  actually behaved after its own past "shock" days (single-day moves large
 *  relative to its own trailing volatility). See lib/insights/eventstudy.server.ts
 *  for the exact definitions. `direction` says which shock type these stats
 *  describe (chosen to match the stock's most recent day-change direction).
 *  All forward-return fields are fractions (0.021 = +2.1%), or null when
 *  `events_found` is 0 (no comparable precedent in the available history —
 *  the honest degrade, never a fabricated number). */
export type MeasuredHistory = {
  direction: ShockDirection;
  window_years: number;
  events_found: number;
  avg_fwd_1w: number | null;
  median_fwd_1w: number | null;
  avg_fwd_1m: number | null;
  median_fwd_1m: number | null;
  worst_1m: number | null;
  best_1m: number | null;
  pct_positive_1m: number | null;
};

export type StockInsight = {
  symbol: string;
  lean: InsightLean;
  confidence: InsightConfidence;
  summary: string;
  drivers: string[]; // 3-5 bullets citing the actual news
  historical_parallel: string; // "in similar past episodes…" — a rhyme, not a prediction
  risks: string[]; // 2-3 bullets
  watch_for: string; // one line: what would change this view
  generatedAt: string; // ISO timestamp
  usedNews: number; // how many news items informed it
  /** MEASURED (not Claude-recalled) history, computed by us and merged in —
   *  the numbers rendered in the UI come from this field, verbatim, never
   *  from Claude's prose. Null if the event-study candle fetch failed. */
  measured_history: MeasuredHistory | null;
};

export type BriefItem = { symbol: string; one_line_what_happened: string; why_it_matters: string };
export type MarketBrief = {
  headline_takeaway: string;
  items: BriefItem[];
  overall_note: string;
};
