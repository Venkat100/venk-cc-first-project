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

export type TodaysBrief = { brief: MarketBrief; createdAt: string } | null;

/** The signed-in user's most recent daily market brief (RLS → own rows). */
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
  return { brief: data.payload as MarketBrief, createdAt: data.created_at };
}

export type { StockInsight, MarketBrief } from "./types";
