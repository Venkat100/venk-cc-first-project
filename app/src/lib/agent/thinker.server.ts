// AI Agent — the "thinker" (server-only orchestrator, Phase 10.2).
//
// Pipeline: load config → QUANT score the universe → fetch news for the
// shortlist → ask Claude to pick + size (falls back to quant-only on any AI
// error) → construct target weights under risk-level guardrails → execute the
// buy/sell deltas into the agent sub-portfolio via agent_execute_trade →
// log a rationale for every action plus an overall rebalance entry.
//
// Manual trigger for now (10.5 wires it to cron). Reads ALL data server-side;
// prices are fetched server-side and never trusted from the client.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { fhCompanyNews } from "@/lib/marketData/finnhub.server";
import { scoreCandidates, type Candidate } from "./quant.server";
import { claudeReason, agentModel, type ClaudeReasoning } from "./anthropic.server";
import { stopPct } from "./watchdog.server";
import type { RiskLevel } from "@/lib/supabase/types";

type Guardrails = { cashBuffer: number; maxPosition: number; minHoldings: number; maxHoldings: number; shortlist: number };

const GUARDRAILS: Record<RiskLevel, Guardrails> = {
  conservative: { cashBuffer: 0.25, maxPosition: 0.25, minHoldings: 5, maxHoldings: 7, shortlist: 8 },
  balanced: { cashBuffer: 0.15, maxPosition: 0.3, minHoldings: 4, maxHoldings: 6, shortlist: 8 },
  aggressive: { cashBuffer: 0.08, maxPosition: 0.35, minHoldings: 3, maxHoldings: 5, shortlist: 7 },
};

export type ThinkerExecution = { symbol: string; side: "buy" | "sell"; quantity: number; price: number; total: number; weight: number; reason: string };

export type ThinkerResult = {
  ran: boolean;
  reason?: string; // why it didn't run
  riskLevel?: RiskLevel;
  aiUsed?: boolean;
  model?: string;
  guardrails?: Guardrails;
  agentCashBefore?: number;
  agentCashAfter?: number;
  candidates?: Candidate[]; // top scored (with signals)
  commentary?: string;
  picks?: ClaudeReasoning["picks"];
  executed?: ThinkerExecution[];
  errors?: string[];
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export async function runThinker(userId: string): Promise<ThinkerResult> {
  const admin = getServiceClient();
  const errors: string[] = [];

  const { data: cfg, error: cfgErr } = await admin.from("agent_config").select("*").eq("user_id", userId).single();
  if (cfgErr || !cfg) return { ran: false, reason: "Agent is not set up yet." };
  if (!cfg.enabled) return { ran: false, reason: "Activate the agent before running it." };
  const agentCashBefore = Number(cfg.agent_cash);
  if (!(agentCashBefore > 0)) return { ran: false, reason: "Fund the agent before running it." };

  const risk = cfg.risk_level as RiskLevel;
  const g = GUARDRAILS[risk];

  // 1) QUANT
  const candidates = await scoreCandidates(risk);
  if (candidates.length === 0) return { ran: false, reason: "No live market data available right now — try again shortly." };
  const shortlist = candidates.slice(0, g.shortlist);

  // 2) NEWS for the shortlist
  const news = await Promise.all(shortlist.map((c) => fhCompanyNews(c.symbol).catch(() => [])));

  // 3) AI reasoning (graceful fallback to quant-only)
  let reasoning: ClaudeReasoning;
  let aiUsed = true;
  try {
    reasoning = await claudeReason({
      riskLevel: risk,
      shortlist: shortlist.map((c, i) => ({
        symbol: c.symbol,
        name: c.name,
        signals: c.signals as unknown as Record<string, number>,
        news: news[i].map((n) => ({ headline: n.headline, summary: n.summary })),
      })),
    });
  } catch (e) {
    aiUsed = false;
    errors.push("AI reasoning unavailable (" + (e instanceof Error ? e.message : "error") + ") — used quant-only ranking.");
    reasoning = {
      commentary: `AI commentary unavailable; selected the top ${g.minHoldings} ${risk} quant-ranked names with equal weighting.`,
      picks: shortlist.slice(0, g.minHoldings).map((c) => ({ symbol: c.symbol, include: true, weight_hint: 1, reason: `Quant rank ${c.score} (momentum ${c.signals.momentum}%, beta ${c.signals.beta}).` })),
    };
  }

  // 4) PORTFOLIO CONSTRUCTION + guardrails
  const bySym = new Map(candidates.map((c) => [c.symbol, c]));
  const pickBySym = new Map(reasoning.picks.map((p) => [p.symbol.toUpperCase(), p]));

  // included = Claude's includes that are actually on the shortlist
  let targets = reasoning.picks
    .filter((p) => p.include && bySym.has(p.symbol.toUpperCase()))
    .map((p) => p.symbol.toUpperCase());
  targets = Array.from(new Set(targets));
  const claudeIncluded = new Set(targets);

  // enforce min holdings (top up from quant ranking) and max holdings (cap)
  for (const c of candidates) {
    if (targets.length >= g.minHoldings) break;
    if (!targets.includes(c.symbol)) targets.push(c.symbol);
  }
  targets = targets.slice(0, g.maxHoldings);

  // Weights: use Claude's weight_hint for genuine includes; topped-up names (or
  // includes with a 0 hint) get a sensible default — the average included hint,
  // or equal-weight — so a min-holdings top-up never floors to a zero position.
  const includedHints = targets
    .filter((s) => claudeIncluded.has(s))
    .map((s) => pickBySym.get(s)?.weight_hint ?? 0)
    .filter((w) => w > 0);
  const defaultWeight = includedHints.length ? includedHints.reduce((a, b) => a + b, 0) / includedHints.length : 1;
  let weights = targets.map((s) => {
    const hint = claudeIncluded.has(s) ? pickBySym.get(s)?.weight_hint ?? 0 : 0;
    return hint > 0 ? hint : defaultWeight;
  });
  const sum0 = weights.reduce((a, b) => a + b, 0);
  weights = weights.map((w) => w / sum0);
  weights = weights.map((w) => Math.min(w, g.maxPosition));
  const sum1 = weights.reduce((a, b) => a + b, 0);
  weights = weights.map((w) => w / sum1);

  const investable = agentCashBefore * (1 - g.cashBuffer);

  // 5) EXECUTE (buys only this phase — fresh agent has no positions to sell)
  const executed: ThinkerExecution[] = [];
  let agentCashAfter = agentCashBefore;
  for (let i = 0; i < targets.length; i++) {
    const sym = targets[i];
    const cand = bySym.get(sym)!;
    const weight = weights[i];
    const dollars = investable * weight;
    const qty = Math.floor(dollars / cand.price);
    if (qty < 1) continue;
    if (qty * cand.price > agentCashAfter) continue; // guardrail: never overspend agent_cash

    // Genuine Claude picks log Claude's rationale; topped-up names log why they
    // were added (so a buy never carries an "exclude" rationale).
    const reason = claudeIncluded.has(sym)
      ? pickBySym.get(sym)?.reason ?? `Quant rank ${cand.score}.`
      : `Added to meet the ${risk} diversification / minimum-holdings guardrail (quant rank ${cand.score}).`;
    const { data: rpc, error } = await admin.rpc("agent_execute_trade", {
      p_user_id: userId,
      p_symbol: sym,
      p_side: "buy",
      p_quantity: qty,
      p_price: cand.price,
      p_reason: reason,
    });
    if (error) {
      errors.push(`buy ${sym}: ${error.message}`);
      continue;
    }
    const r = rpc as Record<string, unknown>;
    agentCashAfter = Number(r.agent_cash);
    executed.push({ symbol: sym, side: "buy", quantity: qty, price: cand.price, total: round2(qty * cand.price), weight: round2(weight), reason });

    // Seed the protective trailing stop at buy time = price × (1 − stopPct);
    // the watchdog (10.3) then ratchets it up as the price rises.
    const seedStop = round2(cand.price * (1 - stopPct(cand.signals.beta, risk)));
    await admin.from("agent_holdings").update({ trailing_stop_price: seedStop }).eq("user_id", userId).eq("symbol", sym);

    // per-action decision log
    await admin.from("agent_decisions").insert({
      user_id: userId,
      action: "buy",
      symbol: sym,
      rationale: reason,
      signals: { ...cand.signals, score: cand.score, weight: round2(weight), source: aiUsed ? "quant+ai" : "quant" },
    });
  }

  // 6) overall rebalance decision entry
  await admin.from("agent_decisions").insert({
    user_id: userId,
    action: "rebalance",
    symbol: null,
    rationale: reasoning.commentary,
    signals: {
      risk_level: risk,
      ai_used: aiUsed,
      cash_buffer: g.cashBuffer,
      targets: executed.map((e) => ({ symbol: e.symbol, weight: e.weight, qty: e.quantity })),
      agent_cash_before: round2(agentCashBefore),
      agent_cash_after: round2(agentCashAfter),
    },
  });

  return {
    ran: true,
    riskLevel: risk,
    aiUsed,
    model: agentModel(),
    guardrails: g,
    agentCashBefore: round2(agentCashBefore),
    agentCashAfter: round2(agentCashAfter),
    candidates: candidates.slice(0, g.shortlist),
    commentary: reasoning.commentary,
    picks: reasoning.picks,
    executed,
    errors,
  };
}
