// Client-side reads for adaptive coaching (B3), through the user's own
// RLS-scoped session — same pattern as lib/journal/queries.ts and
// lib/portfolio/queries.ts. No server function needed for READS: the two
// new profiles columns are covered by the table-wide SELECT grant to
// `authenticated` (0001, never narrowed), and every other table read here
// (option_transactions, margin_events, transactions, holdings,
// journal_entries) already has owner-scoped RLS + a SELECT grant to
// `authenticated` from its own migration.
//
// journal_entries is read here ONLY for a COUNT, never body/title/content —
// the same "id/count only, never content" discipline lib/journal/queries.ts
// already established for getNotedTransactionIds().

import { supabase } from "@/lib/supabase/client";
import type { ExperienceInputs } from "./level";

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in.");
  return data.user.id;
}

export type RawUnlockInputs = {
  optionsUnlockedAt: string | null;
  marginUnlockedAt: string | null;
  /** True if this user has ANY option_transactions row, ever. */
  hasOptionActivity: boolean;
  /** True if margin is enabled right now, OR was ever enabled in the past
   *  (a margin_events row of kind "enabled" exists). Covers a user who
   *  enabled margin, used it, then later turned it off — they still
   *  demonstrated real use and must stay unlocked. */
  hasEverEnabledMargin: boolean;
};

/** Everything computeUnlockStatus() needs for both features, in one round trip. */
export async function getRawUnlockInputs(): Promise<RawUnlockInputs> {
  const userId = await currentUserId();
  const [profileRes, optionActivityRes, marginEventRes] = await Promise.all([
    supabase.from("profiles").select("options_unlocked_at, margin_unlocked_at, margin_enabled").eq("id", userId).single(),
    supabase.from("option_transactions").select("id").eq("user_id", userId).limit(1),
    supabase.from("margin_events").select("id").eq("user_id", userId).eq("kind", "enabled").limit(1),
  ]);
  if (profileRes.error || !profileRes.data) throw profileRes.error ?? new Error("Couldn't load your profile.");
  if (optionActivityRes.error) throw optionActivityRes.error;
  if (marginEventRes.error) throw marginEventRes.error;

  return {
    optionsUnlockedAt: profileRes.data.options_unlocked_at,
    marginUnlockedAt: profileRes.data.margin_unlocked_at,
    hasOptionActivity: (optionActivityRes.data?.length ?? 0) > 0,
    hasEverEnabledMargin: Boolean(profileRes.data.margin_enabled) || (marginEventRes.data?.length ?? 0) > 0,
  };
}

/** The 4 observable-behaviour counts computeExperienceLevel() needs. Never
 *  reads a price, a balance, or journal CONTENT — see the module header. */
export async function getExperienceInputs(): Promise<ExperienceInputs> {
  const userId = await currentUserId();
  const [txRes, optTxRes, journalCountRes, holdingsRes] = await Promise.all([
    supabase.from("transactions").select("symbol").eq("user_id", userId),
    supabase.from("option_transactions").select("symbol").eq("user_id", userId),
    supabase.from("journal_entries").select("id", { count: "exact", head: true }),
    supabase.from("holdings").select("symbol").eq("user_id", userId),
  ]);
  if (txRes.error) throw txRes.error;
  if (optTxRes.error) throw optTxRes.error;
  if (journalCountRes.error) throw journalCountRes.error;
  if (holdingsRes.error) throw holdingsRes.error;

  const symbols = new Set<string>();
  for (const r of txRes.data ?? []) symbols.add(r.symbol);
  for (const r of optTxRes.data ?? []) symbols.add(r.symbol);

  return {
    tradesPlaced: (txRes.data?.length ?? 0) + (optTxRes.data?.length ?? 0),
    distinctInstrumentsUsed: symbols.size,
    journalEntryCount: journalCountRes.count ?? 0,
    currentDistinctHoldings: holdingsRes.data?.length ?? 0,
  };
}

// ── Coach nudge dismissal state (item 6, 2026-08-14 Tier-2 fix pass) ──────
// Keyed by (lesson_key, n) — the exact sample size the underlying
// MetricResult was computed from (see 0028's own migration comment for the
// reasoning). Small table (at most 6 rows/user), so reading them all in one
// round trip is simpler than a per-lesson lookup.

/** lesson_key -> the n it was last dismissed at. */
export async function getNudgeDismissals(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("coach_nudge_dismissals").select("lesson_key, n");
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.lesson_key as string, r.n as number]));
}

/** Upsert — re-dismissing the same lesson_key just updates n/dismissed_at. */
export async function dismissNudge(lessonKey: string, n: number): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from("coach_nudge_dismissals").upsert({ user_id: userId, lesson_key: lessonKey, n, dismissed_at: new Date().toISOString() }, { onConflict: "user_id,lesson_key" });
  if (error) throw error;
}
