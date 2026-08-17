// AI Insights — TanStack Start server functions. Per-stock insight is
// JWT-verified (identity from the verified token, not a client-sent id) and
// runs server-side so the Anthropic key never reaches the browser.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { verifyUser } from "@/lib/supabase/admin.server";
import { getStockInsight, stockInsightStatus } from "./insights.server";
import { track } from "@/lib/analytics/track.server";
import type { StockInsight } from "./types";

export type InsightResponse = { ok: true; insight: StockInsight } | { ok: false; error: string };

export const getStockInsightFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), symbol: z.string().min(1).max(12) }))
  .handler(async ({ data }): Promise<InsightResponse> => {
    try {
      // gate to signed-in users; also the identity the A2 rate-limit guard
      // (inside getStockInsight, checked only on a real cache miss) keys on.
      const userId = await verifyUser(data.accessToken);
      const insight = await getStockInsight(data.symbol, userId);
      void track("insight_viewed", { userId, properties: { symbol: data.symbol.toUpperCase() } });
      return { ok: true, insight };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't generate an insight right now." };
    }
  });

export type InsightStatusResponse = { ok: true; exists: boolean; generatedAt?: string } | { ok: false; error: string };

/** Pre-click status check — never calls Claude, never counts against the
 *  insight rate limit (see stockInsightStatus's own comment). Lets the UI
 *  tell the truth about whether clicking will read an already-done analysis
 *  or trigger fresh work, instead of a single button that always implies
 *  the latter. */
export const getStockInsightStatusFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), symbol: z.string().min(1).max(12) }))
  .handler(async ({ data }): Promise<InsightStatusResponse> => {
    try {
      await verifyUser(data.accessToken);
      const status = await stockInsightStatus(data.symbol);
      return { ok: true, ...status };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't check insight status." };
    }
  });
