// Client entry points for margin (M2). Attaches the user's access token for
// the JWT-verified server functions; the events read is a plain RLS-scoped
// query (margin_events grants `select` to `authenticated`, same pattern as
// lib/portfolio/queries.ts's getTransactions() — no server function needed
// for a read RLS already restricts to the caller's own rows).

import { supabase } from "@/lib/supabase/client";
import { getMarginStateFn, setMarginEnabledFn, repayMarginFn, type MarginState } from "./functions";
import type { MarginEvent } from "@/lib/supabase/types";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

/** The signed-in user's full live margin picture. Always computed from live
 *  prices (never cached) — see functions.ts for why this is safe to call
 *  freely from the dedicated Margin page, but should stay gated behind
 *  `margin_enabled` anywhere else (Dashboard, order panels). */
export async function getMarginState(): Promise<MarginState> {
  const res = await getMarginStateFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return res.state;
}

/** Opt in/out. Disabling is rejected server-side while a loan is outstanding
 *  — the UI should disable the control with a reason before this ever fires
 *  (see app.margin.tsx), not rely on this throwing. */
export async function setMarginEnabled(enabled: boolean): Promise<{ marginEnabled: boolean; marginLoan: number }> {
  const res = await setMarginEnabledFn({ data: { accessToken: await token(), enabled } });
  if (!res.ok) throw new Error(res.error);
  return { marginEnabled: res.marginEnabled, marginLoan: res.marginLoan };
}

/** Manual loan paydown, capped server-side at min(requested, cash, loan). */
export async function repayMargin(amount: number): Promise<{ cashBalance: number; marginLoan: number; repaid: number }> {
  const res = await repayMarginFn({ data: { accessToken: await token(), amount } });
  if (!res.ok) throw new Error(res.error);
  return { cashBalance: res.cashBalance, marginLoan: res.marginLoan, repaid: res.repaid };
}

/** Full margin_events history, newest first — the "what happened to me" feed. */
export async function getMarginEvents(): Promise<MarginEvent[]> {
  const { data, error } = await supabase
    .from("margin_events")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export type { MarginState } from "./functions";
