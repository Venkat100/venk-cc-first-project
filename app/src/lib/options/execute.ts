// Client-side entry point for placing an options trade. Attaches the user's
// current access token (so the server can verify identity) and unwraps the
// server function's { ok, error } envelope into a value-or-throw. Mirrors
// lib/trading/execute.ts exactly.

import { supabase } from "@/lib/supabase/client";
import { executeOptionTradeFn, type OptionSide, type OptionTradeResult } from "./functions";

export type OptionTradeInput = {
  contractId: string;
  side: OptionSide;
  contracts: number;
};

export async function executeOptionTrade(input: OptionTradeInput): Promise<OptionTradeResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired — please sign in again.");

  const res = await executeOptionTradeFn({
    data: {
      accessToken: token,
      contractId: input.contractId.toUpperCase(),
      side: input.side,
      contracts: input.contracts,
    },
  });

  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export type { OptionTradeResult, OptionSide } from "./functions";
