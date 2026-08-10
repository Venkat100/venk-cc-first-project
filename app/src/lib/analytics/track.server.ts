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
  | "option_trade";

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
