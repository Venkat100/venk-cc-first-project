// TanStack Start server function for trade execution.
//
// Security boundary (Phase 6):
//   1. Caller's identity comes from a VERIFIED Supabase JWT (verifyUser), not
//      a client-sent user_id.
//   2. The price is fetched SERVER-SIDE (getServerQuote), never from the client.
//   3. The actual mutation runs in the DB via execute_trade(), called with the
//      service-role key — the function is execute-granted to service_role only.
//   4. All money/position math + atomicity + row locking happen in Postgres.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";

export type TradeResult = {
  cashBalance: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  total: number;
  positionQuantity: number;
  positionAvgCost: number | null;
};

export type TradeResponse = { ok: true; result: TradeResult } | { ok: false; error: string };

// Map raw DB/validation tokens to friendly, specific messages.
function friendly(token: string): string {
  switch (token) {
    case "insufficient_funds": return "Not enough buying power for this order.";
    case "insufficient_shares": return "You don't have enough shares to sell.";
    case "invalid_quantity": return "Enter a quantity greater than zero.";
    case "invalid_price":
    case "no_price": return "No live price available right now — please try again in a moment.";
    case "invalid_side": return "Invalid order side.";
    case "profile_not_found": return "We couldn't find your account.";
    case "not_signed_in": return "Your session has expired — please sign in again.";
    default:
      // Surface Postgres' "…: insufficient_funds" style messages cleanly.
      for (const key of ["insufficient_funds", "insufficient_shares", "invalid_quantity", "invalid_price"]) {
        if (token.includes(key)) return friendly(key);
      }
      return "Sorry — that order couldn't be completed. Please try again.";
  }
}

export const executeTradeFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      symbol: z.string().min(1),
      side: z.enum(["buy", "sell"]),
      quantity: z.number().positive(),
    }),
  )
  .handler(async ({ data }): Promise<TradeResponse> => {
    try {
      // 1) Identity from the verified JWT (never a client-sent user_id).
      const userId = await verifyUser(data.accessToken);

      // 2) Server-fetched price (never trust a client price).
      const quote = await getServerQuote(data.symbol);
      if (!quote || !(quote.price > 0)) return { ok: false, error: friendly("no_price") };

      // 3) Atomic execution in the DB via the service-role client.
      const admin = getServiceClient();
      const { data: rpc, error } = await admin.rpc("execute_trade", {
        p_user_id: userId,
        p_symbol: data.symbol.toUpperCase(),
        p_side: data.side,
        p_quantity: data.quantity,
        p_price: quote.price,
      });

      if (error) return { ok: false, error: friendly(error.message) };

      const r = rpc as Record<string, unknown>;
      return {
        ok: true,
        result: {
          cashBalance: Number(r.cash_balance),
          symbol: String(r.symbol),
          side: r.side as "buy" | "sell",
          quantity: Number(r.quantity),
          price: Number(r.price),
          total: Number(r.total),
          positionQuantity: Number(r.position_quantity),
          positionAvgCost: r.position_avg_cost != null ? Number(r.position_avg_cost) : null,
        },
      };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
