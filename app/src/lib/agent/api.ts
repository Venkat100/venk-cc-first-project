// Client entry points for the AI Agent config + funding. Attach the user's
// access token so the server can verify identity; unwrap envelopes.

import { supabase } from "@/lib/supabase/client";
import { getAgentConfigFn, updateAgentConfigFn, fundAgentFn, runAgentThinkerFn, type FundResponse, type ThinkerResponse } from "./functions";
import type { ThinkerResult } from "./thinker.server";
import type { AgentConfig, AgentMode, RiskLevel } from "@/lib/supabase/types";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

export async function getAgentConfig(): Promise<AgentConfig> {
  return getAgentConfigFn({ data: { accessToken: await token() } });
}

export async function updateAgentConfig(patch: {
  enabled?: boolean;
  mode?: AgentMode;
  risk_level?: RiskLevel;
}): Promise<AgentConfig> {
  return updateAgentConfigFn({ data: { accessToken: await token(), ...patch } });
}

export type FundResult = { cashBalance: number; agentCash: number; allocatedTotal: number };

/** Positive funds (main → agent); negative withdraws (agent → main). */
export async function fundAgent(amount: number): Promise<FundResult> {
  const res: FundResponse = await fundAgentFn({ data: { accessToken: await token(), amount } });
  if (!res.ok) throw new Error(res.error);
  return { cashBalance: res.cashBalance, agentCash: res.agentCash, allocatedTotal: res.allocatedTotal };
}

/** Run the agent's decision engine once (manual trigger). */
export async function runAgentThinker(): Promise<ThinkerResult> {
  const res: ThinkerResponse = await runAgentThinkerFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export type { ThinkerResult } from "./thinker.server";
