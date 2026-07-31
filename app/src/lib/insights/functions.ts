// AI Insights — TanStack Start server functions. Per-stock insight is
// JWT-verified (identity from the verified token, not a client-sent id) and
// runs server-side so the Anthropic key never reaches the browser.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { verifyUser } from "@/lib/supabase/admin.server";
import { getStockInsight } from "./insights.server";
import type { StockInsight } from "./types";

export type InsightResponse = { ok: true; insight: StockInsight } | { ok: false; error: string };

export const getStockInsightFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), symbol: z.string().min(1).max(12) }))
  .handler(async ({ data }): Promise<InsightResponse> => {
    try {
      await verifyUser(data.accessToken); // gate to signed-in users; insight isn't user-specific
      const insight = await getStockInsight(data.symbol);
      return { ok: true, insight };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't generate an insight right now." };
    }
  });
