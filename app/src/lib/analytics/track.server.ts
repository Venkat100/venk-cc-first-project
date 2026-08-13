// Lightweight, privacy-respecting first-party product analytics (PLAN.md
// §6 step 5, part A3) — server-only. See migration 0020's header for the
// full reasoning behind first-party-Postgres over a third-party tool for
// this initial cut, and for why `analytics_events.user_id` deliberately
// survives account deletion as an anonymized (user_id=null) row rather
// than being cascade-deleted.
//
// A THIN abstraction on purpose: every call site only ever calls
// `track(event, opts)` — never touches `analytics_events` directly — so
// pointing this at a third-party tool (PostHog/Plausible/Umami) later is a
// change to THIS ONE FILE, not a rewrite of every call site.
//
// track() must NEVER be able to break the real feature it's attached to:
// every call is fire-and-forget from the caller's perspective (the
// callers below use `void track(...)`, not `await`) and every failure is
// caught and logged here, never rethrown.

import { getServiceClient } from "@/lib/supabase/admin.server";

export type AnalyticsEvent =
  | "signup"
  | "first_trade"
  | "insight_viewed"
  | "agent_run"
  | "option_trade"
  // PLAN.md §6 step 10 (B4) — fired from lib/rateLimit/check.server.ts on
  // both rejection branches (burst and daily). rate_limit_events itself
  // only ever gets a row on an ALLOWED call (0019_rate_limits.sql's
  // check_and_record_rate_limit inserts on the success path only), so
  // rejections were otherwise invisible in the data — this is the only
  // durable trace of a reject, needed for the admin usage dashboard's
  // "rate-limit rejections" figure.
  | "rate_limited"
  // AUDIT.md Part 6(c) item 9 (2026-08-14 Tier-2 fix pass) — the ~8
  // previously-uninstrumented features. `insight_generated` fires ONLY on a
  // genuine cache-miss/fresh-Claude-call (see insights.server.ts) — distinct
  // from the existing `insight_viewed`, which fires on every view including
  // cache hits. `feature_unlocked` covers BOTH options and margin (the same
  // unlockFeatureFn handles both, parameterized by `feature`), so a single
  // event name with a property is more useful than two near-duplicate names.
  | "insight_generated"
  | "scenario_started"
  | "scenario_completed"
  | "coach_visited"
  | "watchlist_add"
  | "margin_enabled"
  | "feature_unlocked"
  | "journal_entry_created"
  // Item 6 (2026-08-14) — the proactive Coach nudge card on Dashboard/Portfolio.
  | "coach_nudge_shown"
  | "coach_nudge_clicked"
  | "coach_nudge_dismissed";

export async function track(
  event: AnalyticsEvent,
  opts: { userId?: string; properties?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const admin = getServiceClient();
    const { error } = await admin
      .from("analytics_events")
      .insert({ user_id: opts.userId ?? null, event, properties: opts.properties ?? null });
    if (error) console.error(`analytics track("${event}") failed (non-fatal):`, error.message);
  } catch (e) {
    console.error(`analytics track("${event}") threw (non-fatal):`, e instanceof Error ? e.message : e);
  }
}
