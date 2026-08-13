// Typed read/write helpers for journal_entries (migration 0023_journal.sql).
//
// No money/price is involved, so — unlike trades — these go straight through
// the Supabase client with owner-only RLS, the same pattern already used for
// `watchlist` (see lib/portfolio/queries.ts). No server function needed.

import { supabase } from "@/lib/supabase/client";
import { trackClientEvent } from "@/lib/analytics/api";
import type { JournalEntry } from "@/lib/supabase/types";

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in.");
  return data.user.id;
}

/** Every journal entry for the signed-in user, newest first. */
export async function getJournalEntries(): Promise<JournalEntry[]> {
  const { data, error } = await supabase
    .from("journal_entries")
    .select("*")
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export type NewJournalEntry = {
  body: string;
  title?: string | null;
  symbol?: string | null;
  entryDate?: string; // YYYY-MM-DD; defaults to today (DB default) if omitted
  transactionId?: string | null;
  optionTransactionId?: string | null;
};

/** Create a standalone or trade-linked entry (at most one link, DB-enforced). */
export async function createJournalEntry(input: NewJournalEntry): Promise<JournalEntry> {
  const user_id = await currentUserId();
  const { data, error } = await supabase
    .from("journal_entries")
    .insert({
      user_id,
      body: input.body,
      title: input.title ?? null,
      symbol: input.symbol?.toUpperCase() ?? null,
      entry_date: input.entryDate,
      transaction_id: input.transactionId ?? null,
      option_transaction_id: input.optionTransactionId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  // Symbol + link presence only — never body/title (journal privacy boundary).
  trackClientEvent("journal_entry_created", {
    symbol: input.symbol?.toUpperCase() ?? null,
    linkedToTrade: !!(input.transactionId || input.optionTransactionId),
  });
  return data;
}

export type JournalEntryEdit = {
  body?: string;
  title?: string | null;
  symbol?: string | null;
  entryDate?: string;
};

/** Edit an entry's own content. The trade link (if any) is immutable —
 *  create a new entry instead of re-pointing one at a different trade. */
export async function updateJournalEntry(id: string, input: JournalEntryEdit): Promise<JournalEntry> {
  const { data, error } = await supabase
    .from("journal_entries")
    .update({
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.symbol !== undefined ? { symbol: input.symbol?.toUpperCase() ?? null } : {}),
      ...(input.entryDate !== undefined ? { entry_date: input.entryDate } : {}),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function deleteJournalEntry(id: string): Promise<void> {
  const { error } = await supabase.from("journal_entries").delete().eq("id", id);
  if (error) throw error;
}

/** Transaction ids (stock trades) that already have a linked note — cheap,
 *  id-only fetch used to render a note indicator in transaction history
 *  without pulling every entry's full body. */
export async function getNotedTransactionIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("journal_entries")
    .select("transaction_id")
    .not("transaction_id", "is", null);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.transaction_id as string));
}

/** Same as above, for option_transaction_id. */
export async function getNotedOptionTransactionIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("journal_entries")
    .select("option_transaction_id")
    .not("option_transaction_id", "is", null);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.option_transaction_id as string));
}
