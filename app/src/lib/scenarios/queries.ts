// Client-side reads for scenario runs, through the user's own RLS-scoped
// session — same pattern as lib/journal/queries.ts. `scenario_runs`/
// `scenario_holdings`/`scenario_transactions` all grant plain SELECT to
// `authenticated` with owner-only RLS (0025_scenario_challenges.sql), so no
// server function is needed for any of these reads.

import { supabase } from "@/lib/supabase/client";
import type { ScenarioRun, ScenarioHolding, ScenarioTransaction } from "@/lib/supabase/types";

/** Every scenario run for the signed-in user, newest first. */
export async function getScenarioRuns(): Promise<ScenarioRun[]> {
  const { data, error } = await supabase.from("scenario_runs").select("*").order("started_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getScenarioRun(runId: string): Promise<ScenarioRun> {
  const { data, error } = await supabase.from("scenario_runs").select("*").eq("id", runId).single();
  if (error) throw error;
  return data;
}

export async function getScenarioHoldings(runId: string): Promise<ScenarioHolding[]> {
  const { data, error } = await supabase.from("scenario_holdings").select("*").eq("run_id", runId).order("symbol");
  if (error) throw error;
  return data ?? [];
}

export async function getScenarioTransactions(runId: string): Promise<ScenarioTransaction[]> {
  const { data, error } = await supabase.from("scenario_transactions").select("*").eq("run_id", runId).order("sim_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
