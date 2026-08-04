// Daily margin-interest accrual (M1, server-only) — thin batch wrapper
// around accrue_margin_interest (0012), which is itself idempotent per day
// via last_interest_accrued_at. Runs for every margin-enabled user
// (including ones with no current loan — the SQL function cheaply no-ops
// for them, just stamping the date so the "days since last accrual"
// bookkeeping never has a gap).

import { getServiceClient } from "@/lib/supabase/admin.server";
import { MARGIN_INTEREST_RATE } from "./config.server";

export type InterestAccrualSummary = {
  checked: number;
  accrued: number;
  totalInterest: number;
  errors: string[];
};

/** `onlyUserId` scopes it to one account (verification / on-demand);
 *  omitted in production so the cron accrues for every margin-enabled user. */
export async function runInterestAccrual(opts: { onlyUserId?: string } = {}): Promise<InterestAccrualSummary> {
  const admin = getServiceClient();
  let q = admin.from("profiles").select("id").eq("margin_enabled", true);
  if (opts.onlyUserId) q = q.eq("id", opts.onlyUserId);
  const { data: profiles, error } = await q;
  if (error) throw new Error("read profiles: " + error.message);

  const errors: string[] = [];
  let accrued = 0;
  let totalInterest = 0;

  for (const p of profiles ?? []) {
    try {
      const { data: rpc, error: rpcErr } = await admin.rpc("accrue_margin_interest", { p_user_id: p.id, p_rate: MARGIN_INTEREST_RATE });
      if (rpcErr) throw new Error(rpcErr.message);
      const r = rpc as { accrued: boolean; interest: number };
      if (r.accrued) {
        accrued++;
        totalInterest += Number(r.interest);
      }
    } catch (e) {
      errors.push(`${p.id}: ${e instanceof Error ? e.message : "interest accrual failed"}`);
    }
  }

  return { checked: (profiles ?? []).length, accrued, totalInterest: Math.round(totalInterest * 100) / 100, errors };
}
