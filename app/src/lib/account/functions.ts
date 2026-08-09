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

// ── Delete account (product-phase kickoff, Part 2) ─────────────────────────
// Deletes the auth.users row via the Supabase Admin API. No custom SQL wipe
// function needed: every user-scoped table in this schema already has
// `references auth.users (id) on delete cascade` (profiles, holdings,
// transactions, watchlist, portfolio_snapshots, agent_config,
// agent_holdings, agent_transactions, agent_decisions, agent_snapshots,
// agent_proposals, option_positions, option_transactions, margin_events,
// account_events; `insights` rows with a non-null user_id too — the
// kind='stock' shared rows have user_id NULL and are correctly untouched,
// they don't belong to any one user) — deleting the auth user cascades
// through all of it atomically at the database level. Verified live with a
// full DB read-back across every table; see verify-account-management.ts.
export type DeleteAccountResponse = { ok: true } | { ok: false; error: string };

export const deleteAccountFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1) }))
  .handler(async ({ data }): Promise<DeleteAccountResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return { ok: false, error: "Sorry — we couldn't delete your account. Please try again." };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
