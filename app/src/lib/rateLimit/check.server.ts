// Per-user abuse & cost guards (PLAN.md §6 step 5, part A2) — server-only.
// Thin wrapper around the atomic check_and_record_rate_limit() Postgres
// function (migration 0019); see that migration's header for the full
// threat-model reasoning and why an event-log table (not a fixed-window
// counter) was chosen.
//
// LIMITS, and the reasoning behind each number:
//
//   insight (getStockInsight, on a genuine cache MISS only — see
//   insights.server.ts): burst 10 per 5 minutes, 50/day. A real person
//   exploring stocks rarely looks up more than a handful of DIFFERENT
//   tickers in a few minutes; 10 distinct symbols in 5 minutes is already
//   an unusually fast research session. 50/day is generous for a very
//   active user (that's still only ~1 new symbol every ~19 minutes across
//   a 16-hour waking day) while capping a scripted symbol-sweep to, at
//   worst, 50 real Claude calls/day/account — bounded, not free, but not
//   a runaway bill either. Repeat views of an ALREADY-cached symbol never
//   count against this at all (see insights.server.ts).
//
//   agentRun ("Run agent now" — runAgentThinkerFn): burst 3 per 5 minutes,
//   20/day. Every invocation does a full quant scan (a burst of provider
//   quote requests) plus, when AI is enabled, one real Claude call — there
//   is no cache to fall back on the way insights has. A genuine user
//   tuning their risk level might click Run 2-3 times in a session to see
//   the effect; 3 per 5 minutes covers that comfortably. 20/day is
//   generous for someone actively experimenting all day, while a scripted
//   loop is capped at 20 real runs/day/account instead of unlimited.
//
// Both are intentionally simple, single numbers today — the natural next
// step when tiering ships (PLAN.md §C) is to look these up from the
// caller's plan/entitlement instead of a flat constant, which is why
// checkAndRecordRateLimit takes the limit CONFIG as a parameter rather
// than hardcoding it internally: a future entitlement lookup slots in by
// changing what's passed in, not by touching this file or its callers'
// error-handling shape.

import { getServiceClient } from "@/lib/supabase/admin.server";

export type RateLimitConfig = {
  action: string;
  burstLimit: number;
  burstWindowSeconds: number;
  dailyLimit: number;
};

export const RATE_LIMITS = {
  insight: { action: "insight", burstLimit: 10, burstWindowSeconds: 300, dailyLimit: 50 },
  agentRun: { action: "agent_run", burstLimit: 3, burstWindowSeconds: 300, dailyLimit: 20 },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimitResult = { allowed: true } | { allowed: false; reason: "burst" | "daily"; message: string };

type RpcResult =
  | { allowed: true; burst_count: number; daily_count: number }
  | { allowed: false; reason: "burst"; retry_after_seconds: number }
  | { allowed: false; reason: "daily"; resets_at: string };

function fmtResetTime(iso: string): string {
  // "resets at midnight UTC" is the honest description for a UTC-day
  // window regardless of the caller's local time zone — spell out the
  // actual UTC clock time too so it's unambiguous, not just "midnight".
  const d = new Date(iso);
  return `${d.toISOString().slice(11, 16)} UTC`;
}

/** Atomically check + (if allowed) record one use of `cfg.action` for
 *  `userId`. Never throws on a normal "over the limit" outcome — that's a
 *  regular `{allowed:false}` result the caller turns into a friendly
 *  message, not an error. Only a genuine infra failure (DB unreachable)
 *  throws. */
export async function checkAndRecordRateLimit(userId: string, cfg: RateLimitConfig): Promise<RateLimitResult> {
  const admin = getServiceClient();
  const { data, error } = await admin.rpc("check_and_record_rate_limit", {
    p_user_id: userId,
    p_action: cfg.action,
    p_burst_limit: cfg.burstLimit,
    p_burst_window_seconds: cfg.burstWindowSeconds,
    p_daily_limit: cfg.dailyLimit,
  });
  if (error) throw new Error(error.message);
  const r = data as RpcResult;

  if (r.allowed) return { allowed: true };
  if (r.reason === "burst") {
    return {
      allowed: false,
      reason: "burst",
      message: `You're doing that a bit fast — please wait about ${r.retry_after_seconds} seconds and try again.`,
    };
  }
  return {
    allowed: false,
    reason: "daily",
    message: `You've reached today's limit for this — resets at ${fmtResetTime(r.resets_at)}.`,
  };
}
