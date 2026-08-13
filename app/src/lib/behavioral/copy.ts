// Presentation-only: turns a MetricResult into the exact sentences a card
// shows. Deliberately observational, never scolding (PLAN.md's own tone
// rule) — every sentence states what happened and why it matters, never
// "you're doing it wrong." Pure and client-safe; no formatting decision here
// affects the underlying numbers in metrics.ts.

import { fmtPct } from "@/lib/mockData";
import { WINDOW_TRADES_AFTER_LOSS } from "./metrics";
import type { MetricResult, DispositionData, OverTradingData, ConcentrationData, RevengeTradingData, WinRateData, JournalCorrelationData, BehavioralAnalytics } from "./metrics";
import type { LessonKey } from "@/lib/coaching/priority";

export type Card = {
  title: string;
  whyItMatters: string;
  available: boolean;
  n: number;
  headline: string; // the main observation, or the honest "not enough data yet" line
  detail?: string; // a supporting second line, shown only when available
};

const pct = (frac: number, digits = 1) => fmtPct(frac * 100, digits);
// For plain magnitudes that are never a gain/loss (a share of portfolio, a
// percentage of time) — fmtPct always prepends "+" for any positive number,
// which is correct for signed returns but wrong here ("+37% of your
// portfolio" reads like a gain).
const unsignedPct = (frac: number, digits = 0) => `${(frac * 100).toFixed(digits)}%`;

export function dispositionCard(r: MetricResult<DispositionData>): Card {
  const whyItMatters = "Selling winners early while holding losers, hoping they recover, is the single best-documented mistake in retail trading — it locks in small wins and lets small losses become big ones.";
  if (!r.available) {
    return { title: "Selling winners vs. holding losers", whyItMatters, available: false, n: r.n, headline: `Not enough trades yet to tell — ${r.reason}.` };
  }
  const d = r.data;
  const headline = d.soldWinnersFaster
    ? `You've sold winners after ${d.avgHoldDaysWinners.toFixed(1)} days on average, and held losers for ${d.avgHoldDaysLosers.toFixed(1)}.`
    : `You've actually held winners longer (${d.avgHoldDaysWinners.toFixed(1)} days) than losers (${d.avgHoldDaysLosers.toFixed(1)}) — no sign of this pattern.`;
  return {
    title: "Selling winners vs. holding losers",
    whyItMatters,
    available: true,
    n: r.n,
    headline,
    detail: `Average result: ${pct(d.avgReturnPctWinners)} on winners, ${pct(d.avgReturnPctLosers)} on losers (${d.winnersN} winning, ${d.losersN} losing closed trades).`,
  };
}

export function overTradingCard(r: MetricResult<OverTradingData>): Card {
  const whyItMatters = "Trading more often isn't good or bad by itself — what matters is whether your busiest periods actually produce worse results than your quieter ones.";
  if (!r.available) {
    return { title: "Trade frequency vs. outcome", whyItMatters, available: false, n: r.n, headline: `Not enough trading history yet — ${r.reason}.` };
  }
  const d = r.data;
  const headline = d.worseWhenActive
    ? `In your higher-activity weeks, trades have averaged ${pct(d.activeWeekAvgReturnPct)} — worse than the ${pct(d.quietWeekAvgReturnPct)} average in your quieter weeks.`
    : `Your higher-activity weeks (${pct(d.activeWeekAvgReturnPct)} average) haven't performed worse than quieter ones (${pct(d.quietWeekAvgReturnPct)}) — no sign of this pattern.`;
  return {
    title: "Trade frequency vs. outcome",
    whyItMatters,
    available: true,
    n: r.n,
    headline,
    detail: `You've placed about ${d.tradesPerWeek.toFixed(1)} trades per week on average, across ${d.weeksSpanned} weeks of activity.`,
  };
}

export function concentrationCard(r: MetricResult<ConcentrationData>): Card {
  const whyItMatters = "A single position that dominates your portfolio means one company's news can swing your whole account — diversification is the simplest, most reliable form of risk control.";
  if (!r.available) {
    return { title: "Portfolio concentration", whyItMatters, available: false, n: r.n, headline: `Not enough data yet — ${r.reason}.` };
  }
  const d = r.data;
  const headline = d.currentLargestSymbol
    ? `${d.currentLargestSymbol} currently makes up about ${unsignedPct(d.currentLargestSharePct)} of your invested capital (by cost basis).`
    : "You don't currently hold any open positions.";
  const detail = d.historyAvailable && d.pctOfTimeOverThreshold !== null
    ? `Since your first trade, your largest position has been over 25% of your portfolio ${unsignedPct(d.pctOfTimeOverThreshold)} of the time.`
    : undefined;
  return { title: "Portfolio concentration", whyItMatters, available: true, n: r.n, headline, detail };
}

export function revengeTradingCard(r: MetricResult<RevengeTradingData>): Card {
  const whyItMatters = "Sizing up right after a loss — trying to win it back fast — is how a single bad trade turns into a much bigger one. Noticing the pattern is the first step to catching it in the moment.";
  if (!r.available) {
    return { title: "Trade size after a loss", whyItMatters, available: false, n: r.n, headline: `Not enough losing trades yet to tell — ${r.reason}.` };
  }
  const d = r.data;
  const pctBigger = Math.round((d.ratio - 1) * 100);
  const headline = d.sizedUpAfterLoss
    ? `In the ${WINDOW_TRADES_AFTER_LOSS} trades right after a loss, your average entry size has been about ${pctBigger}% bigger than usual.`
    : `Your entry size right after a loss hasn't been meaningfully bigger than usual — no sign of this pattern.`;
  return {
    title: "Trade size after a loss",
    whyItMatters,
    available: true,
    n: r.n,
    headline,
    detail: `Typical entry size: about $${d.baselineAvgTradeSizeUSD.toFixed(0)}; average entry in the next ${WINDOW_TRADES_AFTER_LOSS} trades after a loss: about $${d.avgPostLossTradeSizeUSD.toFixed(0)} (${d.lossesConsidered} losses considered, ${d.postLossTradesN} post-loss entries pooled).`,
  };
}

export function winRateCard(r: MetricResult<WinRateData>): Card {
  const whyItMatters = "A high win rate paired with a weak risk-adjusted return is a warning sign, not a success — it usually means many small wins offset by one loss big enough to erase them.";
  if (!r.available) {
    return { title: "Win rate vs. risk-adjusted return", whyItMatters, available: false, n: r.n, headline: `Not enough closed trades yet to tell — ${r.reason}.` };
  }
  const d = r.data;
  const winRatePct = Math.round(d.winRate * 100);
  const headline = `Your win rate is ${winRatePct}% across ${r.n} closed trades.`;
  const riskLine =
    d.riskAdjustedReturn === null
      ? "Not enough variation in results yet to compute a risk-adjusted figure."
      : d.warningHighWinRateWeakRiskAdjusted
        ? `That's a high win rate, but your risk-adjusted return is weak (${d.riskAdjustedReturn.toFixed(2)}) — a sign your wins are small and consistent while your losses are occasionally large.`
        : `Your risk-adjusted return is ${d.riskAdjustedReturn.toFixed(2)} — a rough measure of how consistent your results have been, not just how often you win.`;
  return { title: "Win rate vs. risk-adjusted return", whyItMatters, available: true, n: r.n, headline, detail: riskLine };
}

export function journalCorrelationCard(r: MetricResult<JournalCorrelationData>): Card {
  const whyItMatters = "This compares trades where you wrote down your reasoning against trades where you didn't — using only WHETHER a note exists, never what it says. Your journal's content never leaves your own session.";
  if (!r.available) {
    return { title: "Journalled trades vs. un-journalled", whyItMatters, available: false, n: r.n, headline: `Not enough of both to compare yet — ${r.reason}.` };
  }
  const d = r.data;
  const headline = d.notedPerformedBetter
    ? `Trades with a journal note have averaged ${pct(d.avgReturnPctNoted)}, vs. ${pct(d.avgReturnPctUnnoted)} for trades without one.`
    : `Trades without a journal note have actually averaged better (${pct(d.avgReturnPctUnnoted)}) than trades with one (${pct(d.avgReturnPctNoted)}) — no sign that journalling alone changes outcomes.`;
  return {
    title: "Journalled trades vs. un-journalled",
    whyItMatters,
    available: true,
    n: r.n,
    headline,
    detail: `${d.notedN} journalled closed trades, ${d.unnotedN} without a note.`,
  };
}

// Shared between the Coach page's own "Top Lesson" card and the Dashboard/
// Portfolio nudge (item 6, 2026-08-14 Tier-2 fix pass) — ONE source of the
// per-pattern headline sentence, so the nudge can never say something
// different from what the Coach page itself says about the same finding.
export const CARD_BUILDERS: Record<LessonKey, (a: BehavioralAnalytics) => Card> = {
  disposition: (a) => dispositionCard(a.disposition),
  revengeTrading: (a) => revengeTradingCard(a.revengeTrading),
  overTrading: (a) => overTradingCard(a.overTrading),
  concentration: (a) => concentrationCard(a.concentration),
  winRate: (a) => winRateCard(a.winRate),
  journalCorrelation: (a) => journalCorrelationCard(a.journalCorrelation),
};
