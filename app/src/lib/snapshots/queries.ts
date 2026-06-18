// Client read of the signed-in user's portfolio snapshots (RLS → own rows).

import { supabase } from "@/lib/supabase/client";
import type { PortfolioSnapshot } from "@/lib/supabase/types";

export type Snapshot = Pick<PortfolioSnapshot, "captured_at" | "total_value" | "cash" | "holdings_value">;

export async function getSnapshots(): Promise<Snapshot[]> {
  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("captured_at, total_value, cash, holdings_value")
    .order("captured_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    captured_at: r.captured_at,
    total_value: Number(r.total_value),
    cash: Number(r.cash),
    holdings_value: Number(r.holdings_value),
  }));
}
