// Client reads of the agent's own rows (RLS → own rows). All empty until the
// engine (Phase 10.2+) starts trading.

import { supabase } from "@/lib/supabase/client";
import type { AgentHolding, AgentTransaction, AgentDecision } from "@/lib/supabase/types";

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
