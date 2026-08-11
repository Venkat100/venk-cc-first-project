// Client entry point for behavioural analytics (B2). Attaches the user's
// access token for the JWT-verified server function, same pattern as
// lib/margin/api.ts.
//
// The noted-transaction-id sets are fetched SEPARATELY, through the user's
// own RLS-scoped session (getNotedTransactionIds/getNotedOptionTransactionIds
// — id-only columns, never body/title), then passed as plain data into the
// server function call. This keeps journal_entries entirely off the
// service_role path, matching its deliberate lack of a service_role grant.

import { supabase } from "@/lib/supabase/client";
import { getNotedTransactionIds, getNotedOptionTransactionIds } from "@/lib/journal/queries";
import { getBehavioralAnalyticsFn } from "./functions";
import type { BehavioralAnalytics } from "./metrics";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

export async function getBehavioralAnalytics(): Promise<BehavioralAnalytics> {
  const [accessToken, notedTransactionIds, notedOptionTransactionIds] = await Promise.all([
    token(),
    getNotedTransactionIds(),
    getNotedOptionTransactionIds(),
  ]);
  const res = await getBehavioralAnalyticsFn({
    data: {
      accessToken,
      notedTransactionIds: [...notedTransactionIds],
      notedOptionTransactionIds: [...notedOptionTransactionIds],
    },
  });
  if (!res.ok) throw new Error(res.error);
  return res.analytics;
}

export type { BehavioralAnalytics } from "./metrics";
