// Live positions_value for the margin engine (server-only) — the shared
// input to buying-power and equity calculations. Never a cached/stale
// number for a money decision: stock holdings and option positions are both
// re-priced live at call time.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import { getEnrichedOptionPositions } from "@/lib/options/valuation.server";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Live market value of ALL of a user's positions — stock holdings +
 *  option positions — the `positions_value` input to margin_buying_power()
 *  and the equity/maintenance-requirement math in the monitor. Reused by
 *  the trade functions (only called when margin_enabled, to avoid extra
 *  provider calls when margin is off) and by lib/margin/monitor.server.ts. */
export async function getPositionsValue(userId: string): Promise<number> {
  const admin = getServiceClient();
  const { data: holdings, error } = await admin.from("holdings").select("symbol, quantity").eq("user_id", userId);
  if (error) throw new Error(error.message);

  let stockValue = 0;
  if (holdings && holdings.length > 0) {
    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    const quotes = await providerQuotes(symbols);
    const priceMap = new Map(quotes.map((q) => [q.symbol, q.price]));
    for (const h of holdings) stockValue += (priceMap.get(h.symbol) ?? 0) * Number(h.quantity);
  }

  const optionPositions = await getEnrichedOptionPositions(userId);
  const optionsValue = optionPositions.reduce((sum, p) => sum + p.marketValue, 0);

  return round2(stockValue + optionsValue);
}
