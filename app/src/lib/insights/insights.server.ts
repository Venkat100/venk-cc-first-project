// AI Insights — server-only. News-driven, history-aware ANALYSIS (NOT advice).
//
// Part 1: getStockInsight(symbol) — on demand, cached per symbol per day.
// Part 2: runDailyBriefs() — one compact Claude call per active user per day,
//         folded into the existing daily agent-thinker cron.
//
// Reuses the marketData layer (fhCompanyNews / fhMetrics / providerQuotes, all
// rate-limited + cached) and the Anthropic pattern from lib/agent/anthropic
// (AGENT_MODEL, structured JSON output). No new providers or keys.

import Anthropic from "@anthropic-ai/sdk";
import { requireServerEnv } from "@/lib/marketData/env.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { providerQuotes, fhMetrics, fhCompanyNews, type SymbolMetrics } from "@/lib/marketData/finnhub.server";
import { cached } from "@/lib/marketData/cache.server";
import { agentModel } from "@/lib/agent/anthropic.server";
import { getMeasuredHistory } from "./eventstudy.server";
import type { StockInsight, MarketBrief, MeasuredHistory } from "./types";

// Verification counter: how many Claude calls the insights layer has made.
let _claudeCalls = 0;
export function insightClaudeCalls() {
  return _claudeCalls;
}
export function resetInsightClaudeCalls() {
  _claudeCalls = 0;
}

function client() {
  return new Anthropic({ apiKey: requireServerEnv("ANTHROPIC_API_KEY") });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

type Admin = ReturnType<typeof getServiceClient>;
type InsightRow = { user_id: string | null; kind: "stock" | "brief"; symbol: string | null; payload: unknown; created_at: string };

/** Insert, or UPDATE the payload if today's row already exists.
 *  Written as insert-then-update (not PostgREST upsert) because the uniqueness
 *  rules are PARTIAL unique indexes, which ON CONFLICT cannot infer. */
async function writeInsightRow(admin: Admin, row: InsightRow): Promise<void> {
  const ins = await admin.from("insights").insert(row);
  if (!ins.error) return;
  if (ins.error.code !== "23505") throw new Error(ins.error.message); // not a duplicate
  let q = admin.from("insights").update({ payload: row.payload }).eq("kind", row.kind).eq("created_at", row.created_at);
  q = row.kind === "stock" ? q.eq("symbol", row.symbol as string) : q.eq("user_id", row.user_id as string);
  const upd = await q;
  if (upd.error) throw new Error(upd.error.message);
}

// ── Part 1: per-stock insight ────────────────────────────────────────────────

const INSIGHT_SYSTEM = [
  "You are a research analyst for an EDUCATIONAL paper-trading simulator. You produce ANALYSIS, NOT ADVICE.",
  "You are given ONE stock's recent news (headlines/summaries), quantitative signals (price, day change, beta, momentum, 52-week range position), and — when available — measured_history: REAL statistics WE COMPUTED (not your memory) from this stock's own past price history, showing how it actually moved in the weeks/month after its own similar single-day moves.",
  "Weigh the balance of evidence and characterize the near-term lean.",
  "HARD RULES:",
  "Ground every claim in the provided news or signals — do NOT invent facts, figures, prices, events, or dates.",
  "Do NOT use directive language ('you should', 'buy', 'sell', 'hold') — describe, don't instruct.",
  "The historical_parallel must be framed as a general historical PATTERN/rhyme, explicitly NOT a prediction of this stock.",
  "If measured_history is present and events_found >= 5, GROUND historical_parallel in those exact measured numbers — cite events_found (N) and the median forward return — do NOT state different or invented figures. If events_found is 1-4, you may cite the numbers but must explicitly call the sample small. If measured_history is null or events_found is 0, do NOT state any specific numeric forward-return figures for this stock — say plainly that there isn't enough same-stock precedent in the available price history, and either give a purely qualitative, non-numeric note or omit the numeric angle entirely.",
  "If the news is thin, say so and lean 'neutral' with low confidence rather than overreaching.",
  "Keep it concise. Output MUST match the JSON schema exactly.",
].join(" ");

const INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    lean: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    confidence: { type: "string", enum: ["low", "moderate", "high"] },
    summary: { type: "string" },
    drivers: { type: "array", items: { type: "string" } },
    historical_parallel: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    watch_for: { type: "string" },
  },
  required: ["lean", "confidence", "summary", "drivers", "historical_parallel", "risks", "watch_for"],
  additionalProperties: false,
} as const;

/** On-demand insight — at most ONE Claude call per symbol per day GLOBALLY.
 *
 *  The `insights` table (kind='stock') is the source of truth for "already
 *  generated today", so a cold serverless invocation still costs zero Claude
 *  calls. `cached()` sits on top purely as a hot in-process fast path. */
export async function getStockInsight(symbol: string): Promise<StockInsight> {
  const sym = symbol.toUpperCase();
  const day = today();
  return cached(`insight:${sym}:${day}`, 6 * 60 * 60_000, async () => {
    const admin = getServiceClient();

    // 1) DURABLE check — survives cold starts / new invocations.
    const { data: existing } = await admin
      .from("insights")
      .select("payload")
      .eq("kind", "stock")
      .eq("symbol", sym)
      .eq("created_at", day)
      .maybeSingle();
    if (existing?.payload) return existing.payload as StockInsight;

    // 2) Not generated today anywhere → gather inputs and generate once.
    const [quotes, metrics, news] = await Promise.all([
      providerQuotes([sym]),
      fhMetrics(sym).catch((): SymbolMetrics => ({ symbol: sym })),
      fhCompanyNews(sym, 7, 8).catch(() => []),
    ]);
    const q = quotes[0];
    if (!q || !(q.price > 0)) throw new Error(`No live data for ${sym}.`);

    const momentum = round2(((metrics.return13w ?? 0) + (metrics.return26w ?? 0)) / 2);
    const hi = metrics.week52High ?? q.week52High ?? q.price;
    const lo = metrics.week52Low ?? q.week52Low ?? q.price;
    const pos52 = hi > lo ? round2(Math.min(1, Math.max(0, (q.price - lo) / (hi - lo)))) : 0.5;

    // EVENT STUDY: measured (not recalled) forward-return stats after this
    // stock's own past shock days, matching today's move direction. One
    // Twelve Data candles fetch — same per-day gate as everything else here,
    // so it costs at most one call per symbol per day. Never blocks the
    // insight on failure (rate-limit/provider hiccup) — degrades to null,
    // and the prompt is instructed not to fabricate numbers when it's null.
    const direction = q.dayChangePct >= 0 ? "up" : "down";
    const measuredHistory: MeasuredHistory | null = await getMeasuredHistory(sym, direction).catch(() => null);

    const userContent = JSON.stringify({
      symbol: sym,
      name: q.name,
      signals: { price: q.price, day_change_pct: round2(q.dayChangePct), beta: metrics.beta ?? null, momentum_pct: momentum, pos_in_52wk_range: pos52 },
      recent_news: news.map((n) => ({ headline: n.headline, summary: n.summary })),
      measured_history: measuredHistory && measuredHistory.events_found > 0
        ? {
            direction: measuredHistory.direction,
            window_years: measuredHistory.window_years,
            events_found: measuredHistory.events_found,
            median_fwd_1m_pct: round2((measuredHistory.median_fwd_1m ?? 0) * 100),
            avg_fwd_1m_pct: round2((measuredHistory.avg_fwd_1m ?? 0) * 100),
            worst_1m_pct: round2((measuredHistory.worst_1m ?? 0) * 100),
            best_1m_pct: round2((measuredHistory.best_1m ?? 0) * 100),
            pct_positive_1m: measuredHistory.pct_positive_1m,
          }
        : null,
      task: "Produce the JSON insight. Cite the actual news in drivers/risks. historical_parallel is a general market-history rhyme, not a prediction — ground it in measured_history's real numbers when present (see the system rules), never invented ones.",
    });

    _claudeCalls++;
    const res = await client().messages.create({
      model: agentModel(),
      max_tokens: 1500,
      system: [{ type: "text", text: INSIGHT_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: INSIGHT_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: "user", content: userContent }],
    });
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("Claude returned no insight.");
    const parsed = JSON.parse(text.text) as Omit<StockInsight, "symbol" | "generatedAt" | "usedNews" | "measured_history">;
    // measured_history in the PERSISTED/rendered insight is OUR computed
    // object, verbatim — never Claude's paraphrase — so the UI always shows
    // exactly the numbers we measured, not a number Claude might restate.
    const insight: StockInsight = { symbol: sym, ...parsed, generatedAt: new Date().toISOString(), usedNews: news.length, measured_history: measuredHistory };

    // 3) Persist so every later request today — in ANY invocation, for ANY user —
    //    is served from the DB without another Claude call.
    await writeInsightRow(admin, { user_id: null, kind: "stock", symbol: sym, payload: insight, created_at: day });
    return insight;
  });
}

// ── Part 2: daily market brief ───────────────────────────────────────────────

const BRIEF_SYSTEM = [
  "You are a research analyst for an EDUCATIONAL paper-trading simulator writing a concise daily MARKET BRIEF — ANALYSIS, NOT ADVICE.",
  "You are given a user's tracked symbols (their holdings + watchlist) and each one's recent news.",
  "Write: a one-line headline_takeaway; an item ONLY for symbols that have meaningful news (one_line_what_happened grounded in the headlines + a short why_it_matters); and a short overall_note.",
  "HARD RULES: Ground everything in the provided headlines — do NOT invent facts, figures, or events. No directive language ('you should'/buy/sell). SKIP symbols with no real news rather than inventing. Keep every line short. Output MUST match the JSON schema exactly.",
].join(" ");

const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    headline_takeaway: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { symbol: { type: "string" }, one_line_what_happened: { type: "string" }, why_it_matters: { type: "string" } },
        required: ["symbol", "one_line_what_happened", "why_it_matters"],
        additionalProperties: false,
      },
    },
    overall_note: { type: "string" },
  },
  required: ["headline_takeaway", "items", "overall_note"],
  additionalProperties: false,
} as const;

export type BriefSummary = { day: string; usersConsidered: number; briefsWritten: number; skipped: number; errors: string[] };

const MAX_BRIEF_SYMBOLS = 12;

/** Generate + store today's brief for every user with holdings or a watchlist.
 *  Folded into the daily agent-thinker cron. `onlyUserIds` scopes it (tests). */
export async function runDailyBriefs(opts: { onlyUserIds?: string[] } = {}): Promise<BriefSummary> {
  const admin = getServiceClient();
  const day = today();
  const errors: string[] = [];

  let hq = admin.from("holdings").select("user_id, symbol");
  let wq = admin.from("watchlist").select("user_id, symbol");
  if (opts.onlyUserIds) {
    hq = hq.in("user_id", opts.onlyUserIds);
    wq = wq.in("user_id", opts.onlyUserIds);
  }
  const [{ data: holds, error: hErr }, { data: watch, error: wErr }] = await Promise.all([hq, wq]);
  if (hErr) errors.push("read holdings: " + hErr.message);
  if (wErr) errors.push("read watchlist: " + wErr.message);

  // Union of tracked symbols per user.
  const bySym = new Map<string, Set<string>>();
  const add = (u: string, s: string) => {
    const set = bySym.get(u) ?? new Set<string>();
    set.add(String(s).toUpperCase());
    bySym.set(u, set);
  };
  for (const h of holds ?? []) add(h.user_id, h.symbol);
  for (const w of watch ?? []) add(w.user_id, w.symbol);

  let briefsWritten = 0;
  let skipped = 0;
  for (const [userId, set] of bySym) {
    const symbols = [...set].slice(0, MAX_BRIEF_SYMBOLS);
    if (symbols.length === 0) {
      skipped++;
      continue;
    }
    try {
      const news = await Promise.all(
        symbols.map(async (s) => ({ symbol: s, news: (await fhCompanyNews(s).catch(() => [])).map((n) => ({ headline: n.headline, summary: n.summary })) })),
      );
      const userContent = JSON.stringify({ symbols, per_symbol_news: news, task: "Write the daily brief JSON. Only include items for symbols with real news." });

      _claudeCalls++;
      const res = await client().messages.create({
        model: agentModel(),
        max_tokens: 1200,
        system: [{ type: "text", text: BRIEF_SYSTEM, cache_control: { type: "ephemeral" } }],
        output_config: { format: { type: "json_schema", schema: BRIEF_SCHEMA as unknown as Record<string, unknown> } },
        messages: [{ role: "user", content: userContent }],
      });
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("empty brief");
      const brief = JSON.parse(text.text) as MarketBrief;

      await writeInsightRow(admin, { user_id: userId, kind: "brief", symbol: null, payload: brief, created_at: day });
      briefsWritten++;
    } catch (e) {
      errors.push(`${userId}: ${e instanceof Error ? e.message : "brief failed"}`);
    }
  }

  return { day, usersConsidered: bySym.size, briefsWritten, skipped, errors };
}
