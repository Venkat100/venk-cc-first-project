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
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { track } from "@/lib/analytics/track.server";

export type TradeResult = {
  cashBalance: number;
  marginLoan: number;
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
    z
      .object({
        accessToken: z.string().min(1),
        symbol: z.string().min(1),
        side: z.enum(["buy", "sell"]),
        // Exactly one of these three selects the order mode:
        //  - quantity: a SHARE order (fractional allowed) — qty is trusted as-is.
        //  - amount: a DOLLAR order — the server converts amount -> qty at the
        //    server-fetched price; the client's own estimate is never trusted.
        //  - sellAll: close the whole position at its EXACT stored quantity
        //    (no rounding), so no dust remainder is left behind.
        quantity: z.number().positive().optional(),
        amount: z.number().positive().optional(),
        sellAll: z.boolean().optional(),
      })
      .refine((d) => [d.quantity != null, d.amount != null, d.sellAll === true].filter(Boolean).length === 1, {
        message: "Specify exactly one of quantity, amount, or sellAll.",
      }),
  )
  .handler(async ({ data }): Promise<TradeResponse> => {
    try {
      // 1) Identity from the verified JWT (never a client-sent user_id).
      const userId = await verifyUser(data.accessToken);

      // 2) Server-fetched price (never trust a client price).
      const quote = await getServerQuote(data.symbol);
      if (!quote || !(quote.price > 0)) return { ok: false, error: friendly("no_price") };

      const admin = getServiceClient();
      const sym = data.symbol.toUpperCase();

      // 2b) Margin (M1): only compute positions_value (a live-priced pass
      // over ALL of the user's stock + option positions) when margin is
      // actually enabled — a cheap single-row read decides this, so a
      // margin-off trade does zero extra provider calls, preserving today's
      // performance/behavior exactly when margin is off.
      const { data: marginProfile } = await admin.from("profiles").select("margin_enabled").eq("id", userId).single();
      const positionsValue = marginProfile?.margin_enabled ? await getPositionsValue(userId) : 0;

      // 3) Resolve the actual share quantity to execute, server-side.
      let quantity: number;
      if (data.sellAll) {
        if (data.side !== "sell") return { ok: false, error: "Sell-all only applies to a sell order." };
        const { data: holding } = await admin.from("holdings").select("quantity").eq("user_id", userId).eq("symbol", sym).maybeSingle();
        const held = holding ? Number(holding.quantity) : 0;
        if (held <= 0) return { ok: false, error: friendly("insufficient_shares") };
        quantity = held; // exact stored value — zero dust
      } else if (data.amount != null) {
        // Round to 6dp: enough precision for a sane fractional order, avoids
        // float noise (e.g. 50/207.12 = 0.24151...49999999996).
        const rawQty = Math.round((data.amount / quote.price) * 1e6) / 1e6;
        if (!(rawQty > 0)) return { ok: false, error: "That amount is too small at the current price." };
        if (data.side === "sell") {
          // Cap a dollar-based sell at the held quantity instead of erroring —
          // "sell $X worth" of a position worth less than $X just sells it all.
          const { data: holding } = await admin.from("holdings").select("quantity").eq("user_id", userId).eq("symbol", sym).maybeSingle();
          const held = holding ? Number(holding.quantity) : 0;
          if (held <= 0) return { ok: false, error: friendly("insufficient_shares") };
          quantity = Math.min(rawQty, held);
        } else {
          quantity = rawQty;
        }
      } else {
        quantity = data.quantity!;
      }

      // 4) Atomic execution in the DB via the service-role client.
      const { data: rpc, error } = await admin.rpc("execute_trade", {
        p_user_id: userId,
        p_symbol: sym,
        p_side: data.side,
        p_quantity: quantity,
        p_price: quote.price,
        p_positions_value: positionsValue,
      });

      if (error) return { ok: false, error: friendly(error.message) };

      // Activation tracking: fire-and-forget, never blocks/affects the
      // trade result. "First trade" = this account's transaction COUNT is
      // exactly 1 immediately after this trade's own row was inserted by
      // execute_trade() above — cheap (one indexed count), and correct
      // regardless of buy/sell since this app has no shorting (a sell can
      // never be a user's first-ever transaction in practice).
      void admin
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .then(({ count }) => {
          if (count === 1) void track("first_trade", { userId, properties: { symbol: sym, side: data.side } });
        });

      const r = rpc as Record<string, unknown>;
      return {
        ok: true,
        result: {
          cashBalance: Number(r.cash_balance),
          marginLoan: Number(r.margin_loan ?? 0),
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
