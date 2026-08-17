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
import { checkAndRecordRateLimit, RATE_LIMITS } from "@/lib/rateLimit/check.server";
import { track } from "@/lib/analytics/track.server";
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

/** Cheap existence check for today's cached insight — a single indexed
 *  SELECT, never a Claude call, never touches the A2 rate limit. Lets the
 *  UI show an honest pre-click state ("today's analysis is ready" vs "no
 *  analysis yet today") instead of a generic "Get AI insight" button that
 *  implies the click itself does the (possibly already-done) work. */
export async function stockInsightStatus(symbol: string): Promise<{ exists: boolean; generatedAt?: string }> {
  const sym = symbol.toUpperCase();
  const admin = getServiceClient();
  const { data } = await admin.from("insights").select("payload").eq("kind", "stock").eq("symbol", sym).eq("created_at", today()).maybeSingle();
  const payload = data?.payload as StockInsight | undefined;
  return payload ? { exists: true, generatedAt: payload.generatedAt } : { exists: false };
}

/** On-demand insight — at most ONE Claude call per symbol per day GLOBALLY.
 *
 *  The `insights` table (kind='stock') is the source of truth for "already
 *  generated today", so a cold serverless invocation still costs zero Claude
 *  calls. `cached()` sits on top purely as a hot in-process fast path.
 *
 *  `userId` is OPTIONAL and used ONLY for the A2 rate-limit guard below —
 *  callers that don't have a real end-user in context (cron/tests) omit it
 *  and simply skip the guard. `getStockInsightFn` (the actual user-facing
 *  server function) always passes the verified userId. */
export async function getStockInsight(symbol: string, userId?: string): Promise<StockInsight> {
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

    // A2 abuse guard: checked HERE, at the exact point a real Claude call
    // is about to happen — repeat views of an already-generated symbol
    // return above and never reach this check at all, matching the
    // reasoning in RATE_LIMITS' own comment (marginal cost of a cache HIT
    // is zero, so it shouldn't count against a user's daily allowance;
    // only genuine cache MISSES — a burst across many distinct symbols —
    // are the real cost vector this guards against).
    if (userId) {
      const rl = await checkAndRecordRateLimit(userId, RATE_LIMITS.insight);
      if (!rl.allowed) throw new Error(rl.message);
    }

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
    // Fires ONLY on this genuine cache-miss/fresh-Claude-call path — distinct
    // from `insight_viewed` (functions.ts), which fires on every view
    // including cache hits. This is the real per-symbol generation cost signal.
    void track("insight_generated", { userId, properties: { symbol: sym } });
    return insight;
  });
}

// ── Part 2: daily market brief ───────────────────────────────────────────────

const BRIEF_SYSTEM = [
  "You are a research analyst for an EDUCATIONAL paper-trading simulator writing a concise daily MARKET BRIEF — ANALYSIS, NOT ADVICE.",
  "You are given a user's tracked symbols (their holdings + watchlist) and each one's recent news.",
  "Write: a one-line headline_takeaway; an item ONLY for symbols that have meaningful news (one_line_what_happened grounded in the headlines + a short why_it_matters); and a short overall_note.",
  "Some entries in per_symbol_news are marked is_market_wide:true — broad-market fallback symbols (e.g. a major index ETF), not the user's own holdings or watchlist. Treat them exactly like any other symbol: write an item if there's real, meaningful news for them, skip them if there isn't. Do NOT decide whether to include them based on how many of the user's OWN symbols already have items — that decision is made separately, outside this response; your only job here is to report whether each given symbol, market-wide or not, has real news.",
  "HARD RULES: Ground everything in the provided headlines — do NOT invent facts, figures, or events. No directive language ('you should'/buy/sell). SKIP symbols with no real news rather than inventing. Keep every line short. Output MUST match the JSON schema exactly. Never include a URL or link in any field — none will be shown to you, and any you wrote would be fabricated.",
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

// Broad-market fallback, used ONLY to pad out a thin brief (Part 4) — real
// index-tracking ETFs with reliably real news coverage, not synthetic
// "indices". Deliberately small (2 symbols): "a small number of broad-market
// items", not a second feed. A user whose own tracked-symbol count is at or
// above THIN_TRACKED_THRESHOLD never triggers this at all — zero added
// Finnhub calls for the common case of an already-substantive watchlist.
const MARKET_WIDE_SYMBOLS = ["SPY", "QQQ"] as const;
const THIN_TRACKED_THRESHOLD = 3;
// Whether a market-wide item actually appears in the FINAL brief is decided
// HERE, in code, from the real count of the user's own items Claude wrote —
// never left to the model's own judgment. An earlier version asked Claude to
// self-apply this threshold and it didn't reliably comply (verified live: a
// 1-symbol user with exactly one real own-item still got no market-wide
// item, even though the prompt said "fewer than 2" should include one).
// Deterministic filtering removes that failure mode entirely.
const MIN_OWN_ITEMS_BEFORE_MARKET_WIDE = 2;

/** First article with a real URL for this symbol, or undefined. Picks
 *  deterministically from the SAME news payload already fetched for
 *  generation — never asks Claude for a link, which would fabricate a
 *  plausible-looking one instead of reporting "no article found". */
function pickArticle(items: { url?: string; source?: string }[]): { url: string; source?: string } | undefined {
  const found = items.find((n) => n.url);
  return found?.url ? { url: found.url, source: found.source } : undefined;
}

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
      // Thin tracked list → also fetch the small market-wide fallback set,
      // so a 1-symbol portfolio's brief has something to draw on beyond a
      // single item. `durableCached` (inside fhCompanyNews) means this is at
      // most 2 extra live Finnhub calls PER CALENDAR DAY globally (1h TTL),
      // not per user — every user after the first that day hits cache.
      const marketWideSymbols = symbols.length < THIN_TRACKED_THRESHOLD ? MARKET_WIDE_SYMBOLS.filter((s) => !set.has(s)) : [];
      const marketWideSet = new Set<string>(marketWideSymbols);

      const fetchNews = async (s: string, isMarketWide: boolean) => {
        const items = await fhCompanyNews(s).catch(() => []);
        return { symbol: s, items, is_market_wide: isMarketWide };
      };
      const news = await Promise.all([...symbols.map((s) => fetchNews(s, false)), ...marketWideSymbols.map((s) => fetchNews(s, true))]);
      const newsBySymbol = new Map(news.map((n) => [n.symbol, n.items]));

      const userContent = JSON.stringify({
        symbols,
        per_symbol_news: news.map((n) => ({ symbol: n.symbol, is_market_wide: n.is_market_wide, news: n.items.map((it) => ({ headline: it.headline, summary: it.summary })) })),
        task: "Write the daily brief JSON. Only include items for symbols with real news, subject to the market-wide inclusion rule in the system prompt.",
      });

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
      const parsed = JSON.parse(text.text) as MarketBrief;

      // Attach real article links + the market-wide flag DETERMINISTICALLY
      // IN CODE from the same fetched news, never from Claude's output (the
      // schema has no url/source field at all — Claude cannot echo or
      // invent one).
      const tagged = parsed.items.map((it) => {
        const sym = it.symbol.toUpperCase();
        const article = pickArticle(newsBySymbol.get(sym) ?? []);
        return { ...it, symbol: sym, article_url: article?.url, article_source: article?.source, isMarketWide: marketWideSet.has(sym) };
      });
      // Only keep market-wide items when the user's OWN items are genuinely
      // thin — see MIN_OWN_ITEMS_BEFORE_MARKET_WIDE's comment. Your-holdings
      // items always come first.
      const ownItems = tagged.filter((it) => !it.isMarketWide);
      const marketWideItems = ownItems.length < MIN_OWN_ITEMS_BEFORE_MARKET_WIDE ? tagged.filter((it) => it.isMarketWide) : [];
      const brief: MarketBrief = { ...parsed, items: [...ownItems, ...marketWideItems] };

      await writeInsightRow(admin, { user_id: userId, kind: "brief", symbol: null, payload: brief, created_at: day });
      briefsWritten++;
    } catch (e) {
      errors.push(`${userId}: ${e instanceof Error ? e.message : "brief failed"}`);
    }
  }

  return { day, usersConsidered: bySym.size, briefsWritten, skipped, errors };
}
