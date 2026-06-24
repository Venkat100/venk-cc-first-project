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
import { fhCompanyNews, providerQuotes } from "@/lib/marketData/finnhub.server";
import { scoreCandidates, type Candidate } from "./quant.server";
import { claudeReason, agentModel, type ClaudeReasoning } from "./anthropic.server";
import { stopPct } from "./watchdog.server";
import { planRebalance, DRIFT_BAND, COOLDOWN_DAYS, type PlanTarget, type PlanHolding } from "./rebalance";
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
  held?: string[]; // target positions left within the drift band (no trade)
  cooldownSkipped?: string[]; // targets not bought due to watchdog re-entry cooldown
  errors?: string[];
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export async function runThinker(userId: string, opts: { disableAi?: boolean } = {}): Promise<ThinkerResult> {
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

  // 3) AI reasoning (graceful fallback to quant-only; `disableAi` forces the
  //    deterministic quant-only path — used by tests)
  let reasoning: ClaudeReasoning;
  let aiUsed = !opts.disableAi;
  const quantOnly = (): ClaudeReasoning => ({
    commentary: `AI commentary unavailable; selected the top ${g.minHoldings} ${risk} quant-ranked names with equal weighting.`,
    picks: shortlist.slice(0, g.minHoldings).map((c) => ({ symbol: c.symbol, include: true, weight_hint: 1, reason: `Quant rank ${c.score} (momentum ${c.signals.momentum}%, beta ${c.signals.beta}).` })),
  });
  if (opts.disableAi) {
    reasoning = quantOnly();
  } else {
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
      reasoning = quantOnly();
    }
  }

  // 4) PORTFOLIO CONSTRUCTION + guardrails
  const bySym = new Map(candidates.map((c) => [c.symbol, c]));
  const pickBySym = new Map(reasoning.picks.map((p) => [p.symbol.toUpperCase(), p]));

  // Re-entry cooldown: symbols the watchdog protective-sold within COOLDOWN_DAYS.
  // The watchdog logs those as agent_decisions(action='sell'); the thinker's own
  // trims/exits log as 'trim', so action='sell' uniquely identifies stop-sells.
  const cooldownSince = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recentSells } = await admin
    .from("agent_decisions")
    .select("symbol, created_at")
    .eq("user_id", userId)
    .eq("action", "sell")
    .gte("created_at", cooldownSince);
  const cooldown = new Set((recentSells ?? []).map((r) => String(r.symbol ?? "").toUpperCase()).filter(Boolean));

  // included = Claude's includes on the shortlist; names on cooldown are dropped
  // here (and captured so we can log "skipped on cooldown").
  const rawIncluded = Array.from(
    new Set(reasoning.picks.filter((p) => p.include && bySym.has(p.symbol.toUpperCase())).map((p) => p.symbol.toUpperCase())),
  );
  const cooldownDropped = rawIncluded.filter((s) => cooldown.has(s));
  let targets = rawIncluded.filter((s) => !cooldown.has(s));
  const claudeIncluded = new Set(targets);

  // enforce min holdings (top up from quant ranking, skipping cooldown) + max cap
  for (const c of candidates) {
    if (targets.length >= g.minHoldings) break;
    if (!targets.includes(c.symbol) && !cooldown.has(c.symbol)) targets.push(c.symbol);
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

  // Current holdings + a live price for each (universe scan covers them; fetch
  // any straggler not in the scan).
  const { data: holdRows } = await admin.from("agent_holdings").select("symbol, quantity").eq("user_id", userId);
  const holdings = (holdRows ?? []).map((h) => ({ symbol: String(h.symbol).toUpperCase(), quantity: Number(h.quantity) }));
  const heldSet = new Set(holdings.map((h) => h.symbol));
  const priceOf = (s: string) => bySym.get(s)?.price ?? 0;
  const extraPrice = new Map<string, number>();
  const missing = holdings.filter((h) => !(priceOf(h.symbol) > 0)).map((h) => h.symbol);
  if (missing.length) {
    try {
      const qs = await providerQuotes(missing);
      for (const q of qs) extraPrice.set(q.symbol, q.price);
    } catch (e) {
      errors.push("price held: " + (e instanceof Error ? e.message : "error"));
    }
  }
  const px = (s: string) => (priceOf(s) > 0 ? priceOf(s) : extraPrice.get(s) ?? 0);

  const holdingsValue = holdings.reduce((sum, h) => sum + px(h.symbol) * h.quantity, 0);
  const totalCapital = agentCashBefore + holdingsValue;

  const planTargets: PlanTarget[] = targets.map((s, i) => ({
    symbol: s,
    weight: weights[i],
    price: bySym.get(s)!.price,
    score: bySym.get(s)!.score,
    reason: claudeIncluded.has(s)
      ? pickBySym.get(s)?.reason ?? `Quant rank ${bySym.get(s)!.score}.`
      : `Added to meet the ${risk} diversification / minimum-holdings guardrail (quant rank ${bySym.get(s)!.score}).`,
  }));
  const planHoldings: PlanHolding[] = holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, price: px(h.symbol) }));

  // 5) PLAN the minimal trades (drift band + prefer-cash + cooldown) then EXECUTE.
  const plan = planRebalance({
    targets: planTargets,
    holdings: planHoldings,
    agentCash: agentCashBefore,
    totalCapital,
    cashBuffer: g.cashBuffer,
    maxPosition: g.maxPosition,
    cooldown,
  });

  const executed: ThinkerExecution[] = [];
  let agentCashAfter = agentCashBefore;
  for (const a of plan.actions) {
    const { data: rpc, error } = await admin.rpc("agent_execute_trade", {
      p_user_id: userId,
      p_symbol: a.symbol,
      p_side: a.side,
      p_quantity: a.quantity,
      p_price: a.price,
      p_reason: a.reason,
    });
    if (error) {
      errors.push(`${a.kind} ${a.symbol}: ${error.message}`);
      continue;
    }
    agentCashAfter = Number((rpc as Record<string, unknown>).agent_cash);
    executed.push({ symbol: a.symbol, side: a.side, quantity: a.quantity, price: a.price, total: round2(a.quantity * a.price), weight: 0, reason: a.reason });

    // Seed the protective stop only for NEW positions — never lower an existing
    // (already ratcheted) stop when adding to a held position.
    if (a.side === "buy" && a.isNewPosition && !heldSet.has(a.symbol)) {
      const cand = bySym.get(a.symbol);
      const seedStop = round2(a.price * (1 - stopPct(cand?.signals.beta, risk)));
      await admin.from("agent_holdings").update({ trailing_stop_price: seedStop }).eq("user_id", userId).eq("symbol", a.symbol);
    }

    await admin.from("agent_decisions").insert({
      user_id: userId,
      action: a.kind === "buy" ? "buy" : "trim", // 'trim' covers trims + exits (distinct from watchdog 'sell')
      symbol: a.symbol,
      rationale: a.reason,
      signals: { side: a.side, kind: a.kind, quantity: a.quantity, price: round2(a.price), source: aiUsed ? "quant+ai" : "quant" },
    });
  }

  // All names skipped on cooldown — both AI picks dropped during construction and
  // any double-guarded by the planner.
  const cooldownSkipped = Array.from(new Set([...cooldownDropped, ...plan.cooldownSkipped]));

  // Transparent "didn't fight the watchdog" log for each cooldown-skipped name.
  for (const s of cooldownSkipped) {
    await admin.from("agent_decisions").insert({
      user_id: userId,
      action: "hold",
      symbol: s,
      rationale: `Skipped ${s}: re-entry cooldown — the watchdog protective-sold it within the last ${COOLDOWN_DAYS} days.`,
      signals: { reason: "cooldown", days: COOLDOWN_DAYS },
    });
  }

  // 6) overall rebalance decision entry
  const summary =
    executed.length === 0
      ? `Portfolio within drift bands — no trades needed.${cooldownSkipped.length ? ` (${cooldownSkipped.length} name(s) on re-entry cooldown.)` : ""}`
      : `${reasoning.commentary} — Adjusted ${executed.length} position(s); held ${plan.held.length} within the ±${(DRIFT_BAND * 100).toFixed(0)}pp drift band.`;
  await admin.from("agent_decisions").insert({
    user_id: userId,
    action: "rebalance",
    symbol: null,
    rationale: summary,
    signals: {
      risk_level: risk,
      ai_used: aiUsed,
      cash_buffer: g.cashBuffer,
      drift_band: DRIFT_BAND,
      trades: executed.map((e) => ({ symbol: e.symbol, side: e.side, qty: e.quantity })),
      held_within_band: plan.held,
      cooldown_skipped: cooldownSkipped,
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
    commentary: summary,
    picks: reasoning.picks,
    executed,
    held: plan.held,
    cooldownSkipped,
    errors,
  };
}
