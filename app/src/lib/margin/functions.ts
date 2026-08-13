// Margin — TanStack Start server functions (M1: server-side only, no UI
// yet — these are what M2's margin UI will call). JWT-verified identity,
// service-role execution, same security boundary as every other money path.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { getPositionsValue } from "./valuation.server";
import { MARGIN_INTEREST_RATE, MARGIN_MAINTENANCE_PCT, MARGIN_MAX_LEVERAGE, MARGIN_WARNING_BUFFER_PCT } from "./config.server";
import { track } from "@/lib/analytics/track.server";

const round2 = (n: number) => Math.round(n * 100) / 100;

function friendly(token: string): string {
  switch (token) {
    case "loan_outstanding":
      return "Repay your margin loan before turning margin off.";
    case "invalid_amount":
      return "Enter an amount greater than zero.";
    case "nothing_to_repay":
      return "There's nothing to repay right now.";
    case "profile_not_found":
      return "We couldn't find your account.";
    case "not_signed_in":
      return "Your session has expired — please sign in again.";
    default:
      for (const key of ["loan_outstanding", "invalid_amount", "nothing_to_repay"]) {
        if (token.includes(key)) return friendly(key);
      }
      return "Sorry — that couldn't be completed. Please try again.";
  }
}

export type MarginState = {
  marginEnabled: boolean;
  marginLoan: number;
  marginStatus: "ok" | "warning" | "call";
  cashBalance: number;
  positionsValue: number;
  equity: number;
  /** greatest(0, 2×equity − positionsValue) when enabled, else = cashBalance
   *  — MUST match migration 0012's margin_buying_power() SQL function
   *  exactly; this is a read-only preview computed the identical way, not a
   *  second definition of the formula. */
  buyingPower: number;
  maintenanceRequirement: number;
  /** M2 addition (display-only — these are the SAME constants execute_trade
   *  and the monitor already use server-side; exposing them here so the UI
   *  never hardcodes/re-derives "8%"/"30%"/"10%" as a second source of truth). */
  interestRate: number;
  maintenancePct: number;
  warningBufferPct: number;
};

export type MarginStateResponse = { ok: true; state: MarginState } | { ok: false; error: string };

/** The signed-in user's full live margin picture — everything M2's UI will
 *  need to render: status, loan, and the derived equity/buying-power/
 *  maintenance numbers, all computed from LIVE prices, never cached. */
export const getMarginStateFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1) }))
  .handler(async ({ data }): Promise<MarginStateResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const { data: profile, error } = await admin
        .from("profiles")
        .select("cash_balance, margin_enabled, margin_loan, margin_status")
        .eq("id", userId)
        .single();
      if (error || !profile) return { ok: false, error: friendly("profile_not_found") };

      const cash = Number(profile.cash_balance);
      const loan = Number(profile.margin_loan);
      const enabled = Boolean(profile.margin_enabled);
      const positionsValue = await getPositionsValue(userId);
      const equity = round2(cash + positionsValue - loan);
      const buyingPower = enabled ? round2(Math.max(0, MARGIN_MAX_LEVERAGE * equity - positionsValue)) : cash;
      const maintenanceRequirement = round2(positionsValue * MARGIN_MAINTENANCE_PCT);

      return {
        ok: true,
        state: {
          marginEnabled: enabled,
          marginLoan: loan,
          marginStatus: profile.margin_status as MarginState["marginStatus"],
          cashBalance: cash,
          positionsValue,
          equity,
          buyingPower,
          maintenanceRequirement,
          interestRate: MARGIN_INTEREST_RATE,
          maintenancePct: MARGIN_MAINTENANCE_PCT,
          warningBufferPct: MARGIN_WARNING_BUFFER_PCT,
        },
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't load your margin state right now." };
    }
  });

export type SetMarginEnabledResponse = { ok: true; marginEnabled: boolean; marginLoan: number } | { ok: false; error: string };

/** Opt in/out. Disabling is rejected server-side (by set_margin_enabled)
 *  while a loan is outstanding. */
export const setMarginEnabledFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), enabled: z.boolean() }))
  .handler(async ({ data }): Promise<SetMarginEnabledResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const { data: rpc, error } = await admin.rpc("set_margin_enabled", { p_user_id: userId, p_enabled: data.enabled });
      if (error) return { ok: false, error: friendly(error.message) };
      const r = rpc as Record<string, unknown>;
      if (data.enabled) void track("margin_enabled", { userId });
      return { ok: true, marginEnabled: Boolean(r.margin_enabled), marginLoan: Number(r.margin_loan) };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

export type RepayMarginResponse = { ok: true; cashBalance: number; marginLoan: number; repaid: number } | { ok: false; error: string };

/** Manual loan paydown, capped server-side at min(requested, cash, loan). */
export const repayMarginFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), amount: z.number().positive() }))
  .handler(async ({ data }): Promise<RepayMarginResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const { data: rpc, error } = await admin.rpc("repay_margin", { p_user_id: userId, p_amount: data.amount });
      if (error) return { ok: false, error: friendly(error.message) };
      const r = rpc as Record<string, unknown>;
      return { ok: true, cashBalance: Number(r.cash_balance), marginLoan: Number(r.margin_loan), repaid: Number(r.repaid) };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
