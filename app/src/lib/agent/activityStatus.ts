// Agent activity status — AGENT-AUDIT.md Part 8's pre-launch item: a plain-
// English, always-visible answer to "what is the agent doing," so silence
// is never ambiguous the way it was for the 26-day inert agent.
//
// HARD CONSTRAINT (do not weaken): Part 8 §3 found we can distinguish
// "correctly holding" from "stuck" ONLY for the one failure mode already
// patched (the underfunded flag). For anything else, we cannot tell. Every
// string this module (and its callers) produce MUST therefore be a FACT —
// when the agent last acted, what it last decided, when it runs next —
// and must NEVER assert or imply a health verdict ("healthy," "on track,"
// "working correctly," "nothing to worry about"). If a change to this file
// adds language like that, it is re-introducing the exact guess Part 8
// explicitly said not to make.
//
// The only signal precise enough to answer "has this agent actually acted"
// is agent_decisions.action — 'rebalance'/'watchdog'/'hold' are narrative/
// no-op log entries; 'buy'/'trim'/'sell' are the only three values that
// correspond to a REAL trade (see execute.server.ts / watchdog.server.ts).
// agent_run (the analytics event) is deliberately NOT used here — Part 8 §1
// found it proves the cron cycle completed, which is true even on a
// zero-trade day; it cannot answer this question.

const REAL_TRADE_ACTIONS = new Set(["buy", "trim", "sell"]);

/** A never-traded agent gets flagged after this many days since its first
 *  recorded decision — see AGENT-AUDIT.md Part 8 §4 for the justification:
 *  both real aggressive agents placed their first trade within a day or two
 *  of funding, so several zero-trade days with zero holdings is already
 *  unusual, and short enough to have caught the 26-day incident on day 3. */
export const NEVER_TRADED_IDLE_DAYS = 3;

/** A previously-active agent gets flagged after this many days since its
 *  last real trade — longer than the never-traded threshold on purpose: a
 *  calm market can legitimately leave a well-diversified, at-target
 *  portfolio untouched for a while (the drift band is working as intended),
 *  so a much shorter bar would just manufacture false positives out of
 *  healthy-looking, genuinely-unverifiable holding behavior. */
export const WENT_QUIET_DAYS = 14;

/** vercel.json's `agent-thinker` cron schedule ("30 21 * * *") — kept as an
 *  explicit constant, not re-derived from the cron string, so a schedule
 *  change is a two-place diff (here + vercel.json) instead of a silent
 *  drift between what's configured and what this line promises the user. */
const THINKER_CRON_UTC_HOUR = 21;
const THINKER_CRON_UTC_MINUTE = 30;

export type MinimalDecision = {
  action: string;
  symbol: string | null;
  created_at: string;
  rationale: string | null;
};

export type AgentActivityStatus =
  | { kind: "not_started" }
  | { kind: "never_traded"; sinceDays: number; pastThreshold: boolean; latestAt: string; latestRationale: string | null }
  | { kind: "active"; lastTradeAt: string; lastTradeSummary: string; sinceDays: number; latestAt: string; latestRationale: string | null }
  | { kind: "quiet"; lastTradeAt: string; lastTradeSummary: string; sinceDays: number; latestAt: string; latestRationale: string | null };

function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
}

/** "Bought AMD" / "Trimmed NVDA" / "Protective sell: AMD" — the same labels
 *  already used in app.agent.tsx's decision-log ACTION_META, so the status
 *  line and the decision log never describe the same event differently. */
export function describeTrade(action: string, symbol: string | null): string {
  const sym = symbol ?? "a position";
  if (action === "buy") return `Bought ${sym}`;
  if (action === "sell") return `Protective sell: ${sym}`;
  if (action === "trim") return `Trimmed ${sym}`;
  return `${action} ${sym}`;
}

/** Next agent-thinker cron run, as a real UTC instant — format with
 *  formatInstant() for display (viewer's local zone), same as any other
 *  instant in this app. */
export function nextAgentThinkerRunIso(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), THINKER_CRON_UTC_HOUR, THINKER_CRON_UTC_MINUTE, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/**
 * Computes the agent's activity status from its own agent_decisions rows.
 * Pure — no I/O — so it can run identically client-side (fed the page's
 * already-loaded decision history) and server-side (the admin idle-agent
 * list, across every funded agent). `decisions` need not be pre-sorted.
 */
export function computeAgentActivityStatus(decisions: MinimalDecision[], now: Date = new Date()): AgentActivityStatus {
  if (decisions.length === 0) return { kind: "not_started" };

  const sorted = [...decisions].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const latest = sorted[0];
  const oldest = sorted[sorted.length - 1];
  const lastRealTrade = sorted.find((d) => REAL_TRADE_ACTIONS.has(d.action));

  if (!lastRealTrade) {
    const sinceDays = daysSince(oldest.created_at, now);
    return { kind: "never_traded", sinceDays, pastThreshold: sinceDays >= NEVER_TRADED_IDLE_DAYS, latestAt: latest.created_at, latestRationale: latest.rationale };
  }

  const sinceDays = daysSince(lastRealTrade.created_at, now);
  const lastTradeSummary = describeTrade(lastRealTrade.action, lastRealTrade.symbol);
  if (sinceDays >= WENT_QUIET_DAYS) {
    return { kind: "quiet", lastTradeAt: lastRealTrade.created_at, lastTradeSummary, sinceDays, latestAt: latest.created_at, latestRationale: latest.rationale };
  }
  return { kind: "active", lastTradeAt: lastRealTrade.created_at, lastTradeSummary, sinceDays, latestAt: latest.created_at, latestRationale: latest.rationale };
}

/** True for the two states AGENT-AUDIT.md Part 8 §4 recommends flagging on
 *  the admin idle-agent list — "worth a look," never a diagnosis. */
export function isIdle(status: AgentActivityStatus): boolean {
  return (status.kind === "never_traded" && status.pastThreshold) || status.kind === "quiet";
}

/** One-line, fact-only summary for the admin idle-agent list — same
 *  no-verdict rule as the status line, just terser. Only meaningful for the
 *  two idle-eligible states; other states aren't rendered on that list. */
export function summarizeIdleReason(status: AgentActivityStatus): string {
  if (status.kind === "never_traded") return `No trades — ${status.sinceDays} day${status.sinceDays === 1 ? "" : "s"} since the agent's first run.`;
  if (status.kind === "quiet") return `No trades in ${status.sinceDays} days. Last: ${status.lastTradeSummary}.`;
  return "";
}
