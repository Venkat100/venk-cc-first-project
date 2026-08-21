// AI Agent — risk-level guardrail CONSTANTS (pure, no I/O, no imports beyond
// a type and MIN_TRADE_DOLLARS). Deliberately NOT `.server.ts` suffixed —
// these are business-rule numbers, not secrets, and this file is imported
// from BOTH server code (execute.server.ts re-exports it, thinker.server.ts
// uses it via that re-export) AND client code (app.agent.tsx, to compute a
// LIVE underfunded verdict — see that file's header for the 2026-08-21 bug
// this split was made for: the underfunded banner used to read a STORED
// flag from the agent's last thinker-run decision log, so funding an
// underfunded account didn't clear the banner until the next run, up to
// 24h later. Extracting the guardrail numbers + suggestedMinFunding() into
// a bundle-safe module lets the UI recompute the SAME verdict the thinker
// itself would compute, live, from CURRENT balance — no stale flag).

import type { RiskLevel } from "@/lib/supabase/types";
import { MIN_TRADE_DOLLARS } from "./rebalance";

export type Guardrails = { cashBuffer: number; maxPosition: number; minHoldings: number; maxHoldings: number; shortlist: number };

export const GUARDRAILS: Record<RiskLevel, Guardrails> = {
  conservative: { cashBuffer: 0.25, maxPosition: 0.25, minHoldings: 5, maxHoldings: 7, shortlist: 8 },
  balanced: { cashBuffer: 0.15, maxPosition: 0.3, minHoldings: 4, maxHoldings: 6, shortlist: 8 },
  aggressive: { cashBuffer: 0.08, maxPosition: 0.35, minHoldings: 3, maxHoldings: 5, shortlist: 7 },
};

/** The minimum agent capital (cash + holdings value) below which the thinker
 *  cannot construct a portfolio at this risk level — every target position
 *  would be smaller than MIN_TRADE_DOLLARS. A pure function of risk level
 *  ONLY (no live market data, no current holdings needed), so it's cheap and
 *  safe to compute anywhere, including client-side for an instant verdict —
 *  it is NOT a substitute for the thinker's own real `plan.underfunded`
 *  computation (which also depends on current holdings and live prices),
 *  but it is a faithful, immediately-current proxy for "does this account
 *  look too small for this risk level right now," which is exactly what the
 *  UI banner needs. */
export function suggestedMinFunding(riskLevel: RiskLevel): number {
  const g = GUARDRAILS[riskLevel];
  return Math.ceil((MIN_TRADE_DOLLARS * g.minHoldings) / (1 - g.cashBuffer) / 5) * 5;
}
