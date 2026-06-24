// AI Agent — approve-first proposals (server-only, Phase 10 hardening #4a).
//
// In mode='approve' the thinker writes a PENDING proposal instead of trading.
// The user approves (execute TOWARD the proposed target at CURRENT live prices —
// never stale proposal-time prices — re-validating every guardrail) or rejects
// it. Autonomous mode is unaffected.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import { planRebalance, COOLDOWN_DAYS, type PlanTarget, type PlanHolding } from "./rebalance";
import { GUARDRAILS, round2, executePlan, type ThinkerExecution } from "./execute.server";
import type { AgentProposalTarget, AgentProposalTrade, RiskLevel } from "@/lib/supabase/types";

type Admin = ReturnType<typeof getServiceClient>;

/** Write a fresh pending proposal, superseding any prior pending one. */
export async function writeProposal(
  admin: Admin,
  userId: string,
  p: { target: AgentProposalTarget[]; trades: AgentProposalTrade[]; rationale: string; commentary: string },
): Promise<string> {
  await admin.from("agent_proposals").update({ status: "superseded" }).eq("user_id", userId).eq("status", "pending");
  const { data, error } = await admin
    .from("agent_proposals")
    .insert({ user_id: userId, status: "pending", target: p.target, trades: p.trades, rationale: p.rationale, commentary: p.commentary })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data!.id as string;
}

export type ApproveResult = {
  executed: ThinkerExecution[];
  agentCashBefore: number;
  agentCashAfter: number;
  heldWithinBand: string[];
  cooldownSkipped: string[];
};

/** Approve a pending proposal: execute toward its target at CURRENT prices. */
export async function executeProposal(userId: string, proposalId: string): Promise<ApproveResult> {
  const admin = getServiceClient();

  const { data: prop, error: pErr } = await admin.from("agent_proposals").select("*").eq("id", proposalId).eq("user_id", userId).single();
  if (pErr || !prop) throw new Error("Proposal not found.");
  if (prop.status !== "pending") throw new Error("This proposal is no longer pending.");

  const { data: cfg, error: cErr } = await admin.from("agent_config").select("*").eq("user_id", userId).single();
  if (cErr || !cfg) throw new Error("Agent is not set up.");
  if (!cfg.enabled) throw new Error("Activate the agent before approving.");
  const risk = cfg.risk_level as RiskLevel;
  const g = GUARDRAILS[risk];
  const agentCashBefore = Number(cfg.agent_cash);

  const targetRaw = (prop.target ?? []) as AgentProposalTarget[];

  // Re-apply the watchdog re-entry cooldown at approval time (it may have moved).
  const cooldownSince = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000).toISOString();
  const { data: recentSells } = await admin.from("agent_decisions").select("symbol").eq("user_id", userId).eq("action", "sell").gte("created_at", cooldownSince);
  const cooldown = new Set((recentSells ?? []).map((r) => String(r.symbol ?? "").toUpperCase()).filter(Boolean));

  const allowed = targetRaw.filter((t) => !cooldown.has(t.symbol));
  const cooldownSkipped = targetRaw.filter((t) => cooldown.has(t.symbol)).map((t) => t.symbol);
  // Renormalize weights over the allowed targets so we still fully deploy.
  const wsum = allowed.reduce((s, t) => s + t.weight, 0) || 1;

  // Current holdings + live prices for the union of target + held symbols.
  const { data: holdRows } = await admin.from("agent_holdings").select("symbol, quantity").eq("user_id", userId);
  const holdings = (holdRows ?? []).map((h) => ({ symbol: String(h.symbol).toUpperCase(), quantity: Number(h.quantity) }));
  const symbols = Array.from(new Set([...allowed.map((t) => t.symbol), ...holdings.map((h) => h.symbol)]));
  const quotes = await providerQuotes(symbols);
  const priceBy = new Map(quotes.filter((q) => q.price > 0).map((q) => [q.symbol, q.price]));
  const px = (s: string) => priceBy.get(s) ?? 0;

  const planTargets: PlanTarget[] = allowed.map((t) => ({ symbol: t.symbol, weight: t.weight / wsum, price: px(t.symbol), score: t.score, reason: t.reason }));
  const planHoldings: PlanHolding[] = holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity, price: px(h.symbol) }));
  const totalCapital = agentCashBefore + planHoldings.reduce((s, h) => s + h.price * h.quantity, 0);

  const plan = planRebalance({ targets: planTargets, holdings: planHoldings, agentCash: agentCashBefore, totalCapital, cashBuffer: g.cashBuffer, maxPosition: g.maxPosition, cooldown });

  const betaBySym = new Map(targetRaw.map((t) => [t.symbol, t.beta]));
  const { executed, agentCashAfter, errors } = await executePlan(admin, userId, risk, plan, agentCashBefore, betaBySym, true);

  await admin.from("agent_proposals").update({ status: "approved" }).eq("id", proposalId);
  await admin.from("agent_decisions").insert({
    user_id: userId,
    action: "rebalance",
    symbol: null,
    rationale: executed.length ? `Approved proposal — executed ${executed.length} trade(s) at current prices.` : "Approved proposal — already within drift bands at execution, no trades needed.",
    signals: {
      risk_level: risk,
      source: "approved_proposal",
      proposal_id: proposalId,
      trades: executed.map((e) => ({ symbol: e.symbol, side: e.side, qty: e.quantity })),
      held_within_band: plan.held,
      cooldown_skipped: cooldownSkipped,
      agent_cash_before: round2(agentCashBefore),
      agent_cash_after: round2(agentCashAfter),
      errors,
    },
  });

  return { executed, agentCashBefore: round2(agentCashBefore), agentCashAfter: round2(agentCashAfter), heldWithinBand: plan.held, cooldownSkipped };
}

/** Reject a pending proposal — nothing executes. */
export async function rejectProposal(userId: string, proposalId: string): Promise<void> {
  const admin = getServiceClient();
  const { data: prop } = await admin.from("agent_proposals").select("status").eq("id", proposalId).eq("user_id", userId).single();
  if (!prop) throw new Error("Proposal not found.");
  if (prop.status !== "pending") throw new Error("This proposal is no longer pending.");
  await admin.from("agent_proposals").update({ status: "rejected" }).eq("id", proposalId).eq("user_id", userId);
}

/** Supersede any pending proposal (used when switching to autonomous mode). */
export async function supersedePending(admin: Admin, userId: string): Promise<void> {
  await admin.from("agent_proposals").update({ status: "superseded" }).eq("user_id", userId).eq("status", "pending");
}
