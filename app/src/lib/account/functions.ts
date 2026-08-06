// Account-level (not trading/options/agent/margin-specific) server functions.
// C1b: the real "reset paper account" action — JWT-verified identity,
// service-role execution against the atomic reset_paper_account() SQL
// function (0015). Same security boundary as every other money path.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";

export type ResetPaperAccountResult = {
  cashBalance: number;
  holdingsCleared: number;
  optionPositionsCleared: number;
  agentHoldingsCleared: number;
  pendingProposalsCleared: number;
  marginLoanForgiven: number;
};

export type ResetPaperAccountResponse = { ok: true; result: ResetPaperAccountResult } | { ok: false; error: string };

function friendly(token: string): string {
  if (token.includes("profile_not_found")) return "We couldn't find your account.";
  if (token.includes("not_signed_in")) return "Your session has expired — please sign in again.";
  return "Sorry — the reset couldn't be completed. Please try again.";
}

export const resetPaperAccountFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1) }))
  .handler(async ({ data }): Promise<ResetPaperAccountResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const { data: rpc, error } = await admin.rpc("reset_paper_account", { p_user_id: userId });
      if (error) return { ok: false, error: friendly(error.message) };
      const r = rpc as Record<string, unknown>;
      return {
        ok: true,
        result: {
          cashBalance: Number(r.cash_balance),
          holdingsCleared: Number(r.holdings_cleared),
          optionPositionsCleared: Number(r.option_positions_cleared),
          agentHoldingsCleared: Number(r.agent_holdings_cleared),
          pendingProposalsCleared: Number(r.pending_proposals_cleared),
          marginLoanForgiven: Number(r.margin_loan_forgiven),
        },
      };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
