// Typed read/write helpers for the per-user portfolio tables.
//
// All of these go through the single Supabase client. Row-Level Security
// (migration 0002) means a SELECT only ever returns the signed-in user's
// rows — there's no need to filter by user_id on reads. Writes that insert
// rows must set user_id (the RLS `with check` enforces it equals auth.uid()).

import { supabase } from "@/lib/supabase/client";
import type { Holding, Transaction, WatchlistItem } from "@/lib/supabase/types";

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in.");
  return data.user.id;
}

/** Current positions, ordered by symbol. */
export async function getHoldings(): Promise<Holding[]> {
  const { data, error } = await supabase
    .from("holdings")
    .select("*")
    .order("symbol", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Full transaction ledger, newest first. */
export async function getTransactions(): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Followed symbols, newest first. */
export async function getWatchlist(): Promise<WatchlistItem[]> {
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Add a symbol to the watchlist (no-op if already present). */
export async function addToWatchlist(symbol: string): Promise<void> {
  const user_id = await currentUserId();
  const { error } = await supabase
    .from("watchlist")
    .upsert(
      { user_id, symbol: symbol.toUpperCase() },
      { onConflict: "user_id,symbol", ignoreDuplicates: true },
    );
  if (error) throw error;
}

/** Remove a symbol from the watchlist. */
export async function removeFromWatchlist(symbol: string): Promise<void> {
  const { error } = await supabase
    .from("watchlist")
    .delete()
    .eq("symbol", symbol.toUpperCase());
  if (error) throw error;
}
