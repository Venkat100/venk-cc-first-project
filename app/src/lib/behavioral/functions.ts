// Behavioural analytics — TanStack Start server function (PLAN.md §6 step 7,
// B2). JWT-verified identity, transactions/option_transactions fetched
// server-side (service_role already has SELECT on both — 0017/0010).
//
// Deliberately does NOT touch journal_entries here, in any form.
// journal_entries has NO service_role grant (0023's own comment: a
// deliberate privacy decision, not an oversight — see HANDOFF). The caller
// supplies notedTransactionIds/notedOptionTransactionIds — ids only, sourced
// from the client's OWN authenticated session via
// getNotedTransactionIds()/getNotedOptionTransactionIds() (lib/journal/
// queries.ts, which selects only the id column, never body/title). This
// function only ever sees a list of uuids; it never has the ability to read
// journal content even in principle.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { computeBehavioralAnalytics, type BehavioralAnalytics } from "./metrics";
import type { Transaction, OptionTransaction } from "@/lib/supabase/types";

export type BehavioralAnalyticsResponse = { ok: true; analytics: BehavioralAnalytics } | { ok: false; error: string };

export const getBehavioralAnalyticsFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      notedTransactionIds: z.array(z.string()).default([]),
      notedOptionTransactionIds: z.array(z.string()).default([]),
    }),
  )
  .handler(async ({ data }): Promise<BehavioralAnalyticsResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const [txRes, optRes] = await Promise.all([
        admin.from("transactions").select("*").eq("user_id", userId),
        admin.from("option_transactions").select("*").eq("user_id", userId),
      ]);
      if (txRes.error) throw new Error(txRes.error.message);
      if (optRes.error) throw new Error(optRes.error.message);

      const analytics = computeBehavioralAnalytics({
        transactions: (txRes.data ?? []) as Transaction[],
        optionTransactions: (optRes.data ?? []) as OptionTransaction[],
        notedTransactionIds: new Set(data.notedTransactionIds),
        notedOptionTransactionIds: new Set(data.notedOptionTransactionIds),
      });
      return { ok: true, analytics };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't compute your trading insights right now." };
    }
  });
