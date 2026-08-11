// PLAN.md §6 step 8 (B3) — adaptive coaching's "which ONE lesson right now"
// picker. Pure: takes step 7's BehavioralAnalytics output and returns at
// most a single LessonKey, never a list — the kickoff is explicit that a
// user should see ONE thing at a time, not a wall of criticism.
//
// Respects step 7's own statistical honesty: a lesson can only fire if its
// underlying MetricResult is `available: true` (i.e. cleared its own sample-
// size threshold). No lesson is ever surfaced from an unreliable sample.
//
// A lesson also only fires if the metric's own boolean SIGNATURE is
// present — `available: true` alone just means "we have enough data to have
// an opinion," not "something is wrong." Silence (returning null) is the
// correct, common case for a well-behaved account.

import type { BehavioralAnalytics } from "@/lib/behavioral/metrics";

export type LessonKey = "disposition" | "revengeTrading" | "overTrading" | "concentration" | "winRate" | "journalCorrelation";

// Order = priority when multiple patterns are triggered simultaneously.
// Ranked by real-money cost when this happens to a real trader: the
// disposition effect and revenge trading are the two best-documented,
// costliest retail mistakes (systematically locking in losers, sizing up
// out of frustration); over-trading and concentration are structural risk;
// win-rate-vs-risk-adjusted is advisory framing, not a mistake by itself;
// journal correlation is positive reinforcement, not a warning, so it's
// last — it never needs to "win" against an actual warning.
const PRIORITY: LessonKey[] = ["disposition", "revengeTrading", "overTrading", "concentration", "winRate", "journalCorrelation"];

const CONCENTRATION_TIME_OVER_THRESHOLD = 0.5; // spent more than half its history over-concentrated

function isTriggered(analytics: BehavioralAnalytics, key: LessonKey): boolean {
  switch (key) {
    case "disposition":
      return analytics.disposition.available && analytics.disposition.data.soldWinnersFaster;
    case "revengeTrading":
      return analytics.revengeTrading.available && analytics.revengeTrading.data.sizedUpAfterLoss;
    case "overTrading":
      return analytics.overTrading.available && analytics.overTrading.data.worseWhenActive;
    case "concentration":
      return (
        analytics.concentration.available &&
        analytics.concentration.data.historyAvailable &&
        (analytics.concentration.data.pctOfTimeOverThreshold ?? 0) > CONCENTRATION_TIME_OVER_THRESHOLD
      );
    case "winRate":
      return analytics.winRate.available && analytics.winRate.data.warningHighWinRateWeakRiskAdjusted;
    case "journalCorrelation":
      // Deliberately the mirror image of the others: this fires on GOOD
      // news (journaling correlates with better outcomes) as encouragement
      // to keep the habit, not a corrective warning.
      return analytics.journalCorrelation.available && analytics.journalCorrelation.data.notedPerformedBetter;
  }
}

/** The single highest-priority triggered lesson, or null if none fired —
 *  null is the expected, common result for an account with no flagged
 *  pattern right now. Callers index `analytics[key]` for the underlying
 *  MetricResult to render; this module deliberately owns selection only,
 *  not copy (copy lives alongside the UI, same split as lib/behavioral/copy.ts). */
export function pickTopLesson(analytics: BehavioralAnalytics): LessonKey | null {
  return PRIORITY.find((key) => isTriggered(analytics, key)) ?? null;
}
