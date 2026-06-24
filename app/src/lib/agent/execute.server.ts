// AI Agent — shared execution primitives (server-only).
//
// Risk-level guardrails + the executor that turns a planRebalance() result into
// real trades (agent_execute_trade), seeds stops for new positions, and logs a
// per-action decision. Shared by the autonomous thinker AND the approve-mode
// proposal executor, so both paths enforce identical guardrails and behaviour.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { stopPct } from "./watchdog.server";
import type { RebalancePlan } from "./rebalance";
import type { RiskLevel } from "@/lib/supabase/types";

type Admin = ReturnType<typeof getServiceClient>;

export type Guardrails = { cashBuffer: number; maxPosition: number; minHoldings: number; maxHoldings: number; shortlist: number };

export const GUARDRAILS: Record<RiskLevel, Guardrails> = {
  conservative: { cashBuffer: 0.25, maxPosition: 0.25, minHoldings: 5, maxHoldings: 7, shortlist: 8 },
  balanced: { cashBuffer: 0.15, maxPosition: 0.3, minHoldings: 4, maxHoldings: 6, shortlist: 8 },
  aggressive: { cashBuffer: 0.08, maxPosition: 0.35, minHoldings: 3, maxHoldings: 5, shortlist: 7 },
};

export const round2 = (n: number) => Math.round(n * 100) / 100;

export type ThinkerExecution = { symbol: string; side: "buy" | "sell"; quantity: number; price: number; total: number; weight: number; reason: string };

/** Execute a rebalance plan: trades via agent_execute_trade (sells first, then
 *  buys — order preserved in plan.actions), seed a stop for each NEW position,
 *  and log a buy/trim decision per action. */
export async function executePlan(
  admin: Admin,
  userId: string,
  risk: RiskLevel,
  plan: RebalancePlan,
  agentCashBefore: number,
  betaBySym: Map<string, number>,
  aiUsed: boolean,
): Promise<{ executed: ThinkerExecution[]; agentCashAfter: number; errors: string[] }> {
  const executed: ThinkerExecution[] = [];
  const errors: string[] = [];
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
    if (a.side === "buy" && a.isNewPosition) {
      const seedStop = round2(a.price * (1 - stopPct(betaBySym.get(a.symbol), risk)));
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

  return { executed, agentCashAfter, errors };
}
