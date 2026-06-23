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
  agentSnapshotsWritten: number;
  agentBaselinesSeeded: number;
  errors: string[];
};

export async function runSnapshots(opts: { onlyUserId?: string } = {}): Promise<SnapshotSummary> {
  const admin = getServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const errors: string[] = [];
  // Optionally scope to a single user (used for on-demand / test snapshots) so we
  // don't fan out a price fetch across the whole user base.
  const one = opts.onlyUserId;

  const profilesQ = admin.from("profiles").select("id, cash_balance, created_at");
  const { data: profiles, error: pErr } = await (one ? profilesQ.eq("id", one) : profilesQ);
  if (pErr) throw new Error("read profiles: " + pErr.message);

  const holdingsQ = admin.from("holdings").select("user_id, symbol, quantity");
  const { data: holdings, error: hErr } = await (one ? holdingsQ.eq("user_id", one) : holdingsQ);
  if (hErr) throw new Error("read holdings: " + hErr.message);

  // Agent sub-portfolio (Phase 10.4): config (cash + allocation origin) + holdings.
  const agentCfgQ = admin.from("agent_config").select("user_id, agent_cash, allocated_total, created_at");
  const { data: agentCfg, error: acErr } = await (one ? agentCfgQ.eq("user_id", one) : agentCfgQ);
  if (acErr) errors.push("read agent_config: " + acErr.message);
  const agentHoldingsQ = admin.from("agent_holdings").select("user_id, symbol, quantity");
  const { data: agentHoldings, error: ahErr } = await (one ? agentHoldingsQ.eq("user_id", one) : agentHoldingsQ);
  if (ahErr) errors.push("read agent_holdings: " + ahErr.message);

  // Group holdings by user; collect unique symbols (main + agent share one price fetch).
  const byUser = new Map<string, { symbol: string; quantity: number }[]>();
  const symbols = new Set<string>();
  for (const h of holdings ?? []) {
    const sym = String(h.symbol).toUpperCase();
    symbols.add(sym);
    const arr = byUser.get(h.user_id) ?? [];
    arr.push({ symbol: sym, quantity: Number(h.quantity) });
    byUser.set(h.user_id, arr);
  }

  const agentByUser = new Map<string, { symbol: string; quantity: number }[]>();
  for (const h of agentHoldings ?? []) {
    const sym = String(h.symbol).toUpperCase();
    symbols.add(sym);
    const arr = agentByUser.get(h.user_id) ?? [];
    arr.push({ symbol: sym, quantity: Number(h.quantity) });
    agentByUser.set(h.user_id, arr);
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

  // ── Agent sub-portfolio snapshots ──────────────────────────────────────────
  const agentTodayRows: Array<{ user_id: string; total_value: number; agent_cash: number; holdings_value: number; captured_at: string }> = [];
  const agentBaselineRows: typeof agentTodayRows = [];
  for (const c of agentCfg ?? []) {
    const agentCash = Number(c.agent_cash);
    let holdingsValue = 0;
    for (const h of agentByUser.get(c.user_id) ?? []) holdingsValue += (priceMap.get(h.symbol) ?? 0) * h.quantity;
    const total = agentCash + holdingsValue;
    // Only snapshot agents that have value (funded). An empty/zero agent adds no signal.
    if (total <= 0) continue;
    agentTodayRows.push({ user_id: c.user_id, total_value: round2(total), agent_cash: round2(agentCash), holdings_value: round2(holdingsValue), captured_at: today });

    const created = String(c.created_at).slice(0, 10);
    const allocated = Number(c.allocated_total);
    if (created !== today && allocated > 0) {
      agentBaselineRows.push({ user_id: c.user_id, total_value: round2(allocated), agent_cash: round2(allocated), holdings_value: 0, captured_at: created });
    }
  }

  let agentBaselinesSeeded = 0;
  if (agentBaselineRows.length) {
    const { error } = await admin.from("agent_snapshots").upsert(agentBaselineRows, { onConflict: "user_id,captured_at", ignoreDuplicates: true });
    if (error) errors.push("agent baseline upsert: " + error.message);
    else agentBaselinesSeeded = agentBaselineRows.length;
  }

  let agentSnapshotsWritten = 0;
  if (agentTodayRows.length) {
    const { error } = await admin.from("agent_snapshots").upsert(agentTodayRows, { onConflict: "user_id,captured_at" });
    if (error) errors.push("agent today upsert: " + error.message);
    else agentSnapshotsWritten = agentTodayRows.length;
  }

  return {
    date: today,
    usersProcessed: (profiles ?? []).length,
    snapshotsWritten,
    baselinesSeeded,
    symbolsPriced: symList.length,
    agentSnapshotsWritten,
    agentBaselinesSeeded,
    errors,
  };
}
