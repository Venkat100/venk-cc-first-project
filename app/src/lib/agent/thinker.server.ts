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

import { getServiceClient, logIfFailed } from "@/lib/supabase/admin.server";
import { fhCompanyNews, providerQuotes } from "@/lib/marketData/finnhub.server";
import { scoreCandidates, type Candidate, type UniverseData } from "./quant.server";
import { claudeReason, agentModel, type ClaudeReasoning } from "./anthropic.server";
import { planRebalance, DRIFT_BAND, COOLDOWN_DAYS, MIN_HOLDING_DAYS, MIN_TRADE_DOLLARS, type PlanTarget, type PlanHolding } from "./rebalance";
import { GUARDRAILS, round2, executePlan, type Guardrails, type ThinkerExecution } from "./execute.server";
import { writeProposal } from "./proposals.server";
import type { AgentMode, AgentProposalTarget, AgentProposalTrade, RiskLevel } from "@/lib/supabase/types";

export type { ThinkerExecution } from "./execute.server";

/** For each given (currently held) symbol, find when the CURRENT position was
 *  most recently opened from zero — the timestamp of the buy that took
 *  quantity from 0 to positive, ignoring any earlier exit→rebuy cycle before
 *  that. No `opened_at` column exists on `agent_holdings` (it only tracks
 *  current state), so this replays the symbol's own append-only transaction
 *  ledger — the same technique the behavioral-analytics module already uses
 *  to reconstruct position lifecycle from a ledger with no separate lot
 *  tracking (see lib/behavioral/metrics.ts). Feeds the minimum-holding-period
 *  membership-stickiness guard in rebalance.ts (issue #39). */
async function getPositionOpenedAt(admin: ReturnType<typeof getServiceClient>, userId: string, symbols: string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (symbols.length === 0) return result;
  const { data } = await admin
    .from("agent_transactions")
    .select("symbol, side, quantity, created_at")
    .eq("user_id", userId)
    .in("symbol", symbols)
    .order("created_at", { ascending: true });
  const running = new Map<string, number>();
  for (const t of data ?? []) {
    const sym = String(t.symbol);
    const prevQty = running.get(sym) ?? 0;
    // A small epsilon, not a strict ===0, since these are running sums of
    // 6dp-rounded fractional quantities across potentially many trades.
    if (prevQty <= 1e-9 && t.side === "buy") result.set(sym, new Date(t.created_at));
    running.set(sym, prevQty + (t.side === "buy" ? Number(t.quantity) : -Number(t.quantity)));
  }
  return result;
}

export type ThinkerResult = {
  ran: boolean;
  reason?: string; // why it didn't run
  proposed?: boolean; // approve-mode: wrote a proposal instead of trading
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

export async function runThinker(userId: string, opts: { disableAi?: boolean; prefetch?: UniverseData } = {}): Promise<ThinkerResult> {
  const admin = getServiceClient();
  const errors: string[] = [];

  const { data: cfg, error: cfgErr } = await admin.from("agent_config").select("*").eq("user_id", userId).single();
  if (cfgErr || !cfg) return { ran: false, reason: "Agent is not set up yet." };
  if (!cfg.enabled) return { ran: false, reason: "Activate the agent before running it." };
  const agentCashBefore = Number(cfg.agent_cash);
  if (!(agentCashBefore > 0)) return { ran: false, reason: "Fund the agent before running it." };

  const risk = cfg.risk_level as RiskLevel;
  const g = GUARDRAILS[risk];

  // 1) QUANT (reuse the per-run universe snapshot when the batch supplies one)
  const candidates = await scoreCandidates(risk, opts.prefetch);
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
  const positionOpenedAt = await getPositionOpenedAt(admin, userId, holdings.map((h) => h.symbol));

  // 5) PLAN the minimal trades (drift band + prefer-cash + cooldown + minimum
  //    holding period) then EXECUTE.
  const plan = planRebalance({
    targets: planTargets,
    holdings: planHoldings,
    agentCash: agentCashBefore,
    totalCapital,
    cashBuffer: g.cashBuffer,
    maxPosition: g.maxPosition,
    cooldown,
    positionOpenedAt,
  });

  // All names skipped on cooldown — AI picks dropped during construction plus
  // any double-guarded by the planner.
  const cooldownSkipped = Array.from(new Set([...cooldownDropped, ...plan.cooldownSkipped]));

  // APPROVE MODE: write a reviewable PROPOSAL instead of trading (applies to the
  // manual "Run agent now" button AND the daily cron). Nothing executes.
  if ((cfg.mode as AgentMode) === "approve") {
    const target: AgentProposalTarget[] = planTargets.map((t) => ({
      symbol: t.symbol,
      weight: Math.round(t.weight * 1e4) / 1e4,
      score: t.score,
      beta: bySym.get(t.symbol)?.signals.beta ?? 1,
      reason: t.reason,
    }));
    const trades: AgentProposalTrade[] = plan.actions.map((a) => ({ kind: a.kind, side: a.side, symbol: a.symbol, quantity: a.quantity, price: round2(a.price), reason: a.reason }));
    await writeProposal(admin, userId, {
      target,
      trades,
      rationale: plan.actions.length
        ? `Proposed ${plan.actions.length} change(s) to reach the ${risk} target.`
        : `Proposed: portfolio already within the ±${(DRIFT_BAND * 100).toFixed(0)}pp drift band — no changes.`,
      commentary: reasoning.commentary,
    });
    return {
      ran: true,
      proposed: true,
      riskLevel: risk,
      aiUsed,
      model: agentModel(),
      guardrails: g,
      agentCashBefore: round2(agentCashBefore),
      agentCashAfter: round2(agentCashBefore),
      candidates: candidates.slice(0, g.shortlist),
      commentary: reasoning.commentary,
      picks: reasoning.picks,
      executed: [],
      held: plan.held,
      cooldownSkipped,
      errors,
    };
  }

  // AUTONOMOUS MODE: execute the plan (sells first, then buys).
  const betaBySym = new Map(candidates.map((c) => [c.symbol, c.signals.beta]));
  const exec = await executePlan(admin, userId, risk, plan, agentCashBefore, betaBySym, aiUsed);
  const executed = exec.executed;
  const agentCashAfter = exec.agentCashAfter;
  errors.push(...exec.errors);

  // Transparent "didn't fight the watchdog" log for each cooldown-skipped name.
  for (const s of cooldownSkipped) {
    logIfFailed(`log cooldown-skip decision for ${s}`, await admin.from("agent_decisions").insert({
      user_id: userId,
      action: "hold",
      symbol: s,
      rationale: `Skipped ${s}: re-entry cooldown — the watchdog protective-sold it within the last ${COOLDOWN_DAYS} days.`,
      signals: { reason: "cooldown", days: COOLDOWN_DAYS },
    }), errors);
  }

  // Same transparency for names protected by the minimum holding period
  // (issue #39 — membership stickiness) — would otherwise have been exited
  // as "no longer in the target portfolio."
  for (const s of plan.heldByMinPeriod) {
    logIfFailed(`log min-holding-period decision for ${s}`, await admin.from("agent_decisions").insert({
      user_id: userId,
      action: "hold",
      symbol: s,
      rationale: `Kept ${s}: protected by the ${MIN_HOLDING_DAYS}-day minimum holding period (would otherwise have been exited as no longer in the target set).`,
      signals: { reason: "min_holding_period", days: MIN_HOLDING_DAYS },
    }), errors);
  }

  // 6) overall rebalance decision entry
  // Genuinely-underfunded case (issue #38b): every candidate that needed
  // buying was blocked by MIN_TRADE_DOLLARS, not merely "already at target."
  // Distinguishable message + a suggested minimum, instead of the generic
  // "no trades needed" a healthy at-target agent would ALSO show — that
  // false-healthy message is exactly what let a real $1,000 balanced agent
  // trade nothing for 3+ weeks with zero user-facing signal (AGENT-AUDIT.md
  // Part 3). Suggested minimum: enough investable cash (after the risk
  // level's own cash buffer) to give each of its minHoldings positions at
  // least one real (non-dust) MIN_TRADE_DOLLARS-sized slice, rounded up to a
  // clean $5 for presentation.
  const suggestedMinFunding = plan.underfunded ? Math.ceil((MIN_TRADE_DOLLARS * g.minHoldings) / (1 - g.cashBuffer) / 5) * 5 : undefined;
  const summary = plan.underfunded
    ? `Cannot construct a ${risk} portfolio at this funding level — every target position would be smaller than the $${MIN_TRADE_DOLLARS} minimum trade size. Consider funding at least $${suggestedMinFunding} for this risk level.`
    : executed.length === 0
      ? `Portfolio within drift bands — no trades needed.${cooldownSkipped.length ? ` (${cooldownSkipped.length} name(s) on re-entry cooldown.)` : ""}${plan.heldByMinPeriod.length ? ` (${plan.heldByMinPeriod.length} name(s) protected by the minimum holding period.)` : ""}`
      : `${reasoning.commentary} — Adjusted ${executed.length} position(s); held ${plan.held.length} within the ±${(DRIFT_BAND * 100).toFixed(0)}pp drift band.`;
  logIfFailed("log overall rebalance decision", await admin.from("agent_decisions").insert({
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
      held_by_min_period: plan.heldByMinPeriod,
      underfunded: plan.underfunded,
      suggested_min_funding: suggestedMinFunding ?? null,
      agent_cash_before: round2(agentCashBefore),
      agent_cash_after: round2(agentCashAfter),
    },
  }), errors);

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
