// Client reads of the agent's own rows (RLS → own rows). All empty until the
// engine (Phase 10.2+) starts trading.

import { supabase } from "@/lib/supabase/client";
import type { AgentHolding, AgentTransaction, AgentDecision, AgentProposal } from "@/lib/supabase/types";
import type { Snapshot } from "@/lib/snapshots/queries";

export async function getAgentHoldings(): Promise<AgentHolding[]> {
  const { data, error } = await supabase.from("agent_holdings").select("*").order("symbol", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getAgentTransactions(): Promise<AgentTransaction[]> {
  const { data, error } = await supabase.from("agent_transactions").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getAgentDecisions(): Promise<AgentDecision[]> {
  const { data, error } = await supabase.from("agent_decisions").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** The current pending proposal (approve mode), or null. */
export async function getPendingProposal(): Promise<AgentProposal | null> {
  const { data, error } = await supabase
    .from("agent_proposals")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentProposal) ?? null;
}

/** Agent value history, mapped to the shared Snapshot shape (agent_cash → cash)
 *  so it reuses PortfolioValueChart. */
export async function getAgentSnapshots(): Promise<Snapshot[]> {
  const { data, error } = await supabase
    .from("agent_snapshots")
    .select("captured_at, total_value, agent_cash, holdings_value")
    .order("captured_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    captured_at: r.captured_at,
    total_value: Number(r.total_value),
    cash: Number(r.agent_cash),
    holdings_value: Number(r.holdings_value),
  }));
}
