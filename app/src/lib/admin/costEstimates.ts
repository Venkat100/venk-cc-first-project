// PLAN.md §6 step 10 (B4) — pure cost-estimate constants for the admin
// usage/cost dashboard.
//
// HONESTY CONSTRAINT (kickoff, verbatim): "Make the cost estimate honest —
// show the assumed per-call rates and label it an estimate." Neither Claude
// call site in this codebase captures real token usage (lib/agent/
// anthropic.server.ts and lib/insights/insights.server.ts both read
// res.content but never res.usage), so there is no real $ figure available
// anywhere — every number this module produces is CALL COUNT × an assumed
// flat rate, never a measured cost. The UI must always display these rate
// constants next to the total, not just the total, so the estimate is
// auditable rather than a black box.
//
// Rates are ballpark assumptions for a short structured-JSON completion on
// Claude Sonnet (a few hundred input tokens of prompt/context, a few
// hundred output tokens of response) — NOT looked up from a live pricing
// API. Revisit if real token-usage capture is ever added (the natural fix
// is reading res.usage at both call sites and storing it, which would let
// this whole module be replaced with real arithmetic instead of an
// assumption).
export const ESTIMATED_COST_PER_INSIGHT_CALL_USD = 0.02;

// Agent runs are a coarser proxy: analytics_events' "agent_run" fires on
// every "Run agent now" click, INCLUDING quant-only runs with zero Claude
// calls (agent_config can have AI reasoning disabled per-agent). Costing
// every agent_run as if it made a Claude call is therefore a deliberate
// UPPER BOUND, not a precise estimate — labeled as such wherever it's
// shown. A real per-call AI-used flag would need a schema change to fix
// (agent_decisions/agent_run events don't currently record ai_used).
export const ESTIMATED_COST_PER_AGENT_RUN_USD = 0.05;

export function estimateInsightCostUsd(callCount: number): number {
  return callCount * ESTIMATED_COST_PER_INSIGHT_CALL_USD;
}

export function estimateAgentRunCostUsd(runCount: number): number {
  return runCount * ESTIMATED_COST_PER_AGENT_RUN_USD;
}
