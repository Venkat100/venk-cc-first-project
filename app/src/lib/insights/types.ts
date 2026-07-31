// Shared AI-Insights types (client + server safe — no server imports).

export type InsightLean = "bullish" | "bearish" | "neutral";
export type InsightConfidence = "low" | "moderate" | "high";

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
};

export type BriefItem = { symbol: string; one_line_what_happened: string; why_it_matters: string };
export type MarketBrief = {
  headline_takeaway: string;
  items: BriefItem[];
  overall_note: string;
};
