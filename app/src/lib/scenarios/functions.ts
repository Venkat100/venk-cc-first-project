// PLAN.md §6 step 9 (B5) — Scenario Challenges server functions.
//
// THE NO-LOOK-AHEAD BOUNDARY LIVES HERE, specifically in getScenarioMarketDataFn:
// the browser NEVER receives a candle series — it receives whatever this
// function decides to slice and return. `run.step_index` (the only source
// of truth for "how far has this run progressed") is read from the DB, and
// every symbol's series is sliced with calendar.ts's sliceUpToDate() before
// the response is built. There is no code path in this file that returns an
// unsliced series for an ACTIVE run.
//
// Same JWT-verified, service-role pattern as every other money-adjacent
// server function in this app (lib/margin/functions.ts, lib/coaching/
// functions.ts). Historical series are fetched via the shared marketData
// primitives ONLY (providerSeries + durableCached) — never a direct
// Twelve Data/Finnhub call, per CLAUDE.md's provider-isolation rule.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { providerSeries } from "@/lib/marketData/provider.server";
import { durableCached } from "@/lib/marketData/cache.server";
import type { Candle } from "@/lib/marketData/types";
import { getScenario, scenarioSymbolSet, type Scenario } from "./catalog";
import { maxStepIndex, cutoffDateForStep, sliceUpToDate, closeOnOrBefore, closeOnExact } from "./calendar";
import { computeScenarioScore, type ScenarioScore } from "./scoring";
import type { ScenarioRun } from "@/lib/supabase/types";

// Historical data for a FIXED, already-elapsed date range never changes —
// long TTL is safe and keeps repeat fetches (every "advance"/trade click)
// almost entirely off the provider after the first user to touch a scenario.
const SERIES_TTL = 24 * 60 * 60_000; // 24h

function seriesCached(symbol: string, scenario: Scenario): Promise<Candle[]> {
  return durableCached("scenario_series", symbol.toUpperCase(), scenario.id, SERIES_TTL, () =>
    providerSeries(symbol, scenario.startDate, scenario.endDate),
  );
}

function friendly(token: string): string {
  if (token.includes("run_already_active")) return "You already have an active run of this scenario — resume it instead of starting a new one.";
  if (token.includes("run_not_found")) return "We couldn't find that scenario run.";
  if (token.includes("run_not_active")) return "This scenario run has already ended.";
  if (token.includes("run_not_completed")) return "This scenario run hasn't finished yet.";
  if (token.includes("insufficient_cash")) return "Not enough cash in this scenario for that trade.";
  if (token.includes("insufficient_shares")) return "You don't hold enough shares in this scenario to sell that many.";
  if (token.includes("invalid_starting_cash") || token.includes("invalid_quantity") || token.includes("invalid_price") || token.includes("invalid_steps") || token.includes("invalid_side")) {
    return "That request didn't look valid — please try again.";
  }
  if (token.includes("not_signed_in")) return "Your session has expired — please sign in again.";
  return "Sorry — that couldn't be completed. Please try again.";
}

async function loadRun(admin: ReturnType<typeof getServiceClient>, userId: string, runId: string): Promise<ScenarioRun> {
  const { data, error } = await admin.from("scenario_runs").select("*").eq("id", runId).eq("user_id", userId).single();
  if (error || !data) throw new Error("run_not_found");
  return data as ScenarioRun;
}

// A server function's return type must be concretely serializable — the DB
// row type's `final_score: unknown` (a jsonb column, same convention as
// margin_events.detail/agent_decisions.signals) is fine for a plain client
// read but not for crossing the RPC boundary, so every response below sends
// this narrowed view instead of the raw ScenarioRun row.
export type ScenarioRunPublic = {
  id: string;
  user_id: string;
  scenario_id: string;
  status: ScenarioRun["status"];
  cash: number;
  starting_cash: number;
  step_index: number;
  final_score: ScenarioScore | null;
  started_at: string;
  completed_at: string | null;
};
function toPublicRun(run: ScenarioRun): ScenarioRunPublic {
  return {
    id: run.id,
    user_id: run.user_id,
    scenario_id: run.scenario_id,
    status: run.status,
    cash: Number(run.cash),
    starting_cash: Number(run.starting_cash),
    step_index: run.step_index,
    final_score: (run.final_score as ScenarioScore | null) ?? null,
    started_at: run.started_at,
    completed_at: run.completed_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
export type StartScenarioResponse = { ok: true; run: ScenarioRunPublic } | { ok: false; error: string };

export const startScenarioRunFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), scenarioId: z.string().min(1) }))
  .handler(async ({ data }): Promise<StartScenarioResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const scenario = getScenario(data.scenarioId);
      if (!scenario) return { ok: false, error: "That's not a recognized scenario." };

      const admin = getServiceClient();
      const rpc = await admin.rpc("start_scenario_run", {
        p_user_id: userId,
        p_scenario_id: scenario.id,
        p_starting_cash: scenario.startingCash,
      });
      if (rpc.error) return { ok: false, error: friendly(rpc.error.message) };
      return { ok: true, run: toPublicRun(rpc.data as ScenarioRun) };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type ScenarioMarketData = {
  run: ScenarioRunPublic;
  scenarioId: string;
  cutoffDate: string;
  maxStepIndex: number;
  /** Symbol -> candle series sliced up to cutoffDate. NEVER beyond it. */
  series: Record<string, Candle[]>;
  /** Symbol -> latest visible close (the "current price" a trade executes at). */
  latestPrices: Record<string, number>;
};

export type GetScenarioMarketDataResponse = { ok: true; data: ScenarioMarketData } | { ok: false; error: string };

export const getScenarioMarketDataFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), runId: z.string().min(1) }))
  .handler(async ({ data }): Promise<GetScenarioMarketDataResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const run = await loadRun(admin, userId, data.runId);
      const scenario = getScenario(run.scenario_id);
      if (!scenario) return { ok: false, error: "That scenario is no longer available." };

      const symbols = scenarioSymbolSet(scenario);
      const seriesFull = await Promise.all(symbols.map((s) => seriesCached(s, scenario)));
      const calendar = seriesFull[symbols.indexOf(scenario.benchmarkSymbol)];
      const realMaxIndex = maxStepIndex(calendar);

      // A COMPLETED run reveals the full window for review/debrief — there's
      // no look-ahead concern once the scenario is actually over. An ACTIVE
      // run is strictly bounded by its own progress.
      const cutoffDate = run.status === "completed" ? scenario.endDate : cutoffDateForStep(calendar, Math.min(run.step_index, realMaxIndex));

      const series: Record<string, Candle[]> = {};
      const latestPrices: Record<string, number> = {};
      symbols.forEach((s, i) => {
        const sliced = sliceUpToDate(seriesFull[i], cutoffDate);
        series[s] = sliced;
        const price = closeOnOrBefore(seriesFull[i], cutoffDate);
        if (price != null) latestPrices[s] = price;
      });

      return {
        ok: true,
        data: { run: toPublicRun(run), scenarioId: scenario.id, cutoffDate, maxStepIndex: realMaxIndex, series, latestPrices },
      };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
async function scoreCompletedRun(admin: ReturnType<typeof getServiceClient>, userId: string, run: ScenarioRun, scenario: Scenario): Promise<ScenarioScore> {
  const tradeableSymbols = scenario.symbols.map((s) => s.symbol);
  const allSymbols = scenarioSymbolSet(scenario);
  const seriesFull = await Promise.all(allSymbols.map((s) => seriesCached(s, scenario)));

  const pricesAtStart: Record<string, number> = {};
  const pricesAtEnd: Record<string, number> = {};
  allSymbols.forEach((s, i) => {
    const startPrice = closeOnExact(seriesFull[i], scenario.startDate) ?? closeOnOrBefore(seriesFull[i], scenario.startDate);
    const endPrice = closeOnOrBefore(seriesFull[i], scenario.endDate);
    if (startPrice != null) pricesAtStart[s] = startPrice;
    if (endPrice != null) pricesAtEnd[s] = endPrice;
  });

  const holdingsRes = await admin.from("scenario_holdings").select("symbol, quantity").eq("run_id", run.id);
  const finalHoldings = ((holdingsRes.data ?? []) as { symbol: string; quantity: number }[]).map((h) => ({ symbol: h.symbol, quantity: Number(h.quantity) }));

  return computeScenarioScore({
    scenario: { ...scenario, symbols: scenario.symbols.filter((s) => tradeableSymbols.includes(s.symbol)) },
    finalCash: Number(run.cash),
    finalHoldings,
    pricesAtStart,
    pricesAtEnd,
  });
}

export type AdvanceScenarioResponse = { ok: true; run: ScenarioRunPublic; score: ScenarioScore | null } | { ok: false; error: string };

export const advanceScenarioStepFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), runId: z.string().min(1) }))
  .handler(async ({ data }): Promise<AdvanceScenarioResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const runBefore = await loadRun(admin, userId, data.runId);
      const scenario = getScenario(runBefore.scenario_id);
      if (!scenario) return { ok: false, error: "That scenario is no longer available." };

      const calendar = await seriesCached(scenario.benchmarkSymbol, scenario);
      const realMaxIndex = maxStepIndex(calendar);

      const rpc = await admin.rpc("advance_scenario_step", {
        p_user_id: userId,
        p_run_id: data.runId,
        p_steps: scenario.stepTradingDays,
        p_max_index: realMaxIndex,
      });
      if (rpc.error) return { ok: false, error: friendly(rpc.error.message) };
      let run = rpc.data as ScenarioRun;

      let score: ScenarioScore | null = null;
      if (run.status === "completed") {
        if (run.final_score) {
          score = run.final_score as ScenarioScore;
        } else {
          score = await scoreCompletedRun(admin, userId, run, scenario);
          const fin = await admin.rpc("finalize_scenario_run", { p_user_id: userId, p_run_id: run.id, p_final_score: score });
          if (!fin.error) run = fin.data as ScenarioRun;
        }
      }

      return { ok: true, run: toPublicRun(run), score };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type ScenarioTradeResult = {
  cash: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  total: number;
  positionQuantity: number;
  positionAvgCost: number | null;
};
export type ExecuteScenarioTradeResponse = { ok: true; result: ScenarioTradeResult } | { ok: false; error: string };

export const executeScenarioTradeFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      runId: z.string().min(1),
      symbol: z.string().min(1).max(12),
      side: z.enum(["buy", "sell"]),
      quantity: z.number().positive(),
    }),
  )
  .handler(async ({ data }): Promise<ExecuteScenarioTradeResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const run = await loadRun(admin, userId, data.runId);
      const scenario = getScenario(run.scenario_id);
      if (!scenario) return { ok: false, error: "That scenario is no longer available." };

      const symbol = data.symbol.toUpperCase().trim();
      if (!scenarioSymbolSet(scenario).includes(symbol)) {
        return { ok: false, error: `${symbol} isn't part of this scenario's curated symbol set.` };
      }
      if (run.status !== "active") return { ok: false, error: friendly("run_not_active") };

      const calendar = await seriesCached(scenario.benchmarkSymbol, scenario);
      const cutoffDate = cutoffDateForStep(calendar, Math.min(run.step_index, maxStepIndex(calendar)));
      const symbolSeries = await seriesCached(symbol, scenario);
      const price = closeOnOrBefore(symbolSeries, cutoffDate);
      if (price == null) return { ok: false, error: `No price is available for ${symbol} on this simulated date.` };

      const rpc = await admin.rpc("execute_scenario_trade", {
        p_user_id: userId,
        p_run_id: data.runId,
        p_symbol: symbol,
        p_side: data.side,
        p_quantity: data.quantity,
        p_price: price,
        p_sim_date: cutoffDate,
      });
      if (rpc.error) return { ok: false, error: friendly(rpc.error.message) };
      const r = rpc.data as Record<string, unknown>;
      return {
        ok: true,
        result: {
          cash: Number(r.cash),
          symbol: String(r.symbol),
          side: data.side,
          quantity: Number(r.quantity),
          price: Number(r.price),
          total: Number(r.total),
          positionQuantity: Number(r.position_quantity),
          positionAvgCost: r.position_avg_cost == null ? null : Number(r.position_avg_cost),
        },
      };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
