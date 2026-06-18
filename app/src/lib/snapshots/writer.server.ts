// Daily portfolio-snapshot writer (server-only).
//
// For EVERY user: read cash + holdings, fetch current prices via the marketData
// layer, compute holdings_value = Σ(qty×price) and total_value = cash +
// holdings_value, then UPSERT today's portfolio_snapshots row (re-running the
// same day overwrites — never duplicates, thanks to unique(user_id,captured_at)).
//
// Also ensures a chart ORIGIN: a $100k snapshot on each user's account-creation
// day (insert-if-absent), so the value chart has a sensible starting point.
//
// Runs as the service-role client (bypasses RLS; granted table access in 0004).
// Triggered by the token-protected /api/cron/snapshot endpoint (Vercel Cron in
// Phase 9).

import { getServiceClient } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";

const STARTING_CAPITAL = 100000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type SnapshotSummary = {
  date: string;
  usersProcessed: number;
  snapshotsWritten: number;
  baselinesSeeded: number;
  symbolsPriced: number;
  errors: string[];
};

export async function runSnapshots(): Promise<SnapshotSummary> {
  const admin = getServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const errors: string[] = [];

  const { data: profiles, error: pErr } = await admin.from("profiles").select("id, cash_balance, created_at");
  if (pErr) throw new Error("read profiles: " + pErr.message);

  const { data: holdings, error: hErr } = await admin.from("holdings").select("user_id, symbol, quantity");
  if (hErr) throw new Error("read holdings: " + hErr.message);

  // Group holdings by user; collect unique symbols.
  const byUser = new Map<string, { symbol: string; quantity: number }[]>();
  const symbols = new Set<string>();
  for (const h of holdings ?? []) {
    const sym = String(h.symbol).toUpperCase();
    symbols.add(sym);
    const arr = byUser.get(h.user_id) ?? [];
    arr.push({ symbol: sym, quantity: Number(h.quantity) });
    byUser.set(h.user_id, arr);
  }

  // Price every held symbol once (Finnhub).
  const priceMap = new Map<string, number>();
  const symList = [...symbols];
  if (symList.length) {
    const quotes = await providerQuotes(symList);
    for (const q of quotes) priceMap.set(q.symbol, q.price);
  }

  const todayRows: Array<{ user_id: string; total_value: number; cash: number; holdings_value: number; captured_at: string }> = [];
  const baselineRows: typeof todayRows = [];

  for (const p of profiles ?? []) {
    const cash = Number(p.cash_balance);
    let holdingsValue = 0;
    for (const h of byUser.get(p.id) ?? []) holdingsValue += (priceMap.get(h.symbol) ?? 0) * h.quantity;
    const total = cash + holdingsValue;

    todayRows.push({ user_id: p.id, total_value: round2(total), cash: round2(cash), holdings_value: round2(holdingsValue), captured_at: today });

    const created = String(p.created_at).slice(0, 10);
    if (created !== today) {
      baselineRows.push({ user_id: p.id, total_value: STARTING_CAPITAL, cash: STARTING_CAPITAL, holdings_value: 0, captured_at: created });
    }
  }

  let baselinesSeeded = 0;
  if (baselineRows.length) {
    // Insert-if-absent: never clobber a real prior snapshot.
    const { error } = await admin
      .from("portfolio_snapshots")
      .upsert(baselineRows, { onConflict: "user_id,captured_at", ignoreDuplicates: true });
    if (error) errors.push("baseline upsert: " + error.message);
    else baselinesSeeded = baselineRows.length;
  }

  let snapshotsWritten = 0;
  if (todayRows.length) {
    // Overwrite same-day rows so a re-run is idempotent.
    const { error } = await admin
      .from("portfolio_snapshots")
      .upsert(todayRows, { onConflict: "user_id,captured_at" });
    if (error) errors.push("today upsert: " + error.message);
    else snapshotsWritten = todayRows.length;
  }

  return {
    date: today,
    usersProcessed: (profiles ?? []).length,
    snapshotsWritten,
    baselinesSeeded,
    symbolsPriced: symList.length,
    errors,
  };
}
