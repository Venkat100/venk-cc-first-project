// Client-side entry point for placing a paper trade. Attaches the user's
// current access token (so the server can verify identity) and unwraps the
// server function's { ok, error } envelope into a value-or-throw.

import { supabase } from "@/lib/supabase/client";
import { executeTradeFn, type TradeResult } from "./functions";

export type TradeInput = { symbol: string; side: "buy" | "sell"; quantity: number };

export async function executeTrade(input: TradeInput): Promise<TradeResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired — please sign in again.");

  const res = await executeTradeFn({
    data: {
      accessToken: token,
      symbol: input.symbol.toUpperCase(),
      side: input.side,
      quantity: input.quantity,
    },
  });

  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export type { TradeResult } from "./functions";
