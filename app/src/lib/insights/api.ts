// Client entry points for AI Insights. Attach the user's access token; unwrap.

import { supabase } from "@/lib/supabase/client";
import { getStockInsightFn, getStockInsightStatusFn, type InsightResponse } from "./functions";
import type { MarketBrief, StockInsight } from "./types";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

/** On-demand AI insight for a symbol (cached server-side per day). */
export async function getStockInsight(symbol: string): Promise<StockInsight> {
  const res: InsightResponse = await getStockInsightFn({ data: { accessToken: await token(), symbol: symbol.toUpperCase() } });
  if (!res.ok) throw new Error(res.error);
  return res.insight;
}

export type InsightStatus = { exists: boolean; generatedAt?: string };

/** Cheap pre-click check — does today's cached insight for this symbol
 *  already exist? Never calls Claude, never counts against the rate limit. */
export async function getStockInsightStatus(symbol: string): Promise<InsightStatus> {
  const res = await getStockInsightStatusFn({ data: { accessToken: await token(), symbol: symbol.toUpperCase() } });
  if (!res.ok) throw new Error(res.error);
  return { exists: res.exists, generatedAt: res.generatedAt };
}

/**
 * `isToday` closes a real incident (2026-08-19 — HANDOFF.md): the query
 * below always returns the MOST RECENT brief row, which is correct when a
 * fresh one exists but silently returns a STALE one when today's cron run
 * didn't reach this user before its time budget ran out — real gap dates
 * for real users, confirmed live. Without `isToday`, MarketBriefCard had no
 * way to tell "here's today's brief" from "here's the most recent one we
 * have, which isn't today's" apart from an 11px footer date easy to miss
 * under a card titled "Today's market brief" regardless — the same failure
 * shape as an insight rendering the wrong instant, just for a whole day's
 * analysis instead of a timestamp. `created_at` is a genuine Postgres
 * `date` column (a CALENDAR DATE, not an instant) written using the
 * server's own UTC day boundary (insights.server.ts's `today()`) — compared
 * here the same way, UTC, not the viewer's local date, so this can't
 * disagree with the server about which day "today" is the way a
 * local-zone comparison could near a day boundary.
 */
export type TodaysBrief = { brief: MarketBrief; createdAt: string; isToday: boolean } | null;

/** The signed-in user's most recent daily market brief (RLS → own rows) —
 *  NOT necessarily today's; see `isToday`. */
export async function getTodaysBrief(): Promise<TodaysBrief> {
  const { data, error } = await supabase
    .from("insights")
    .select("payload, created_at")
    .eq("kind", "brief")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const isToday = data.created_at === new Date().toISOString().slice(0, 10);
  return { brief: data.payload as MarketBrief, createdAt: data.created_at, isToday };
}

export type { StockInsight, MarketBrief } from "./types";
