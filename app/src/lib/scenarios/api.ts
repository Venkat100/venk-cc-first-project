// Client entry points for Scenario Challenges. Same token-attached pattern
// as lib/margin/api.ts / lib/coaching/api.ts.

import { supabase } from "@/lib/supabase/client";
import {
  startScenarioRunFn,
  getScenarioMarketDataFn,
  advanceScenarioStepFn,
  executeScenarioTradeFn,
  type ScenarioMarketData,
  type ScenarioRunPublic,
  type ScenarioTradeResult,
} from "./functions";
import type { ScenarioScore } from "./scoring";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

export async function startScenarioRun(scenarioId: string): Promise<ScenarioRunPublic> {
  const res = await startScenarioRunFn({ data: { accessToken: await token(), scenarioId } });
  if (!res.ok) throw new Error(res.error);
  return res.run;
}

export async function getScenarioMarketData(runId: string): Promise<ScenarioMarketData> {
  const res = await getScenarioMarketDataFn({ data: { accessToken: await token(), runId } });
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export type AdvanceScenarioResult = { run: ScenarioRunPublic; score: ScenarioScore | null };

export async function advanceScenarioStep(runId: string): Promise<AdvanceScenarioResult> {
  const res = await advanceScenarioStepFn({ data: { accessToken: await token(), runId } });
  if (!res.ok) throw new Error(res.error);
  return { run: res.run, score: res.score };
}

export async function executeScenarioTrade(runId: string, symbol: string, side: "buy" | "sell", quantity: number): Promise<ScenarioTradeResult> {
  const res = await executeScenarioTradeFn({ data: { accessToken: await token(), runId, symbol, side, quantity } });
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export type { ScenarioMarketData, ScenarioRunPublic, ScenarioTradeResult } from "./functions";
export type { ScenarioScore } from "./scoring";
