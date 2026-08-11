// BEHAVIOURAL ANALYTICS (PLAN.md §6 step 7, B2) — pure, deterministic
// statistics computed entirely from a user's own ledger. NO AI calls: every
// number here is arithmetic over transactions/option_transactions, fully
// reproducible and free to run. Independently unit-testable against a
// synthetic ledger, same convention as eventstudy.server.ts's shock detector.
//
// CORE IDEA: this schema has no lot-level tracking (holdings/option_positions
// store a single weighted-average cost per symbol, not per-lot). So "closed
// positions" are RECONSTRUCTED from the append-only transaction ledger by
// replaying it in chronological order and mirroring the exact weighted-avg-
// cost math execute_trade/execute_option_trade already use server-side (buys
// update avg cost; sells don't). This is provably consistent with the real
// engine, not an approximation of it.
//
// STATISTICAL HONESTY (non-negotiable): every metric carries the sample size
// N it's based on, and a documented minimum before it's considered
// meaningful. Below threshold, callers get `available: false` with the
// reason — never a shaky number. Thresholds are deliberately small (trade
// counts are naturally much smaller than the daily-return series
// eventstudy.server.ts works with) but never zero.

import type { Transaction, OptionTransaction } from "@/lib/supabase/types";

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
function diffDays(later: string, earlier: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / 86_400_000;
}
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

// ─── Uniform result shape: every metric self-reports its sample size and
// whether it cleared its own minimum. ────────────────────────────────────
export type MetricResult<T> =
  | { available: true; n: number; data: T }
  | { available: false; n: number; minRequired: number; reason: string };

function gate<T>(n: number, minRequired: number, reason: string, data: () => T): MetricResult<T> {
  if (n < minRequired) return { available: false, n, minRequired, reason };
  return { available: true, n, data: data() };
}

// ─── Closing-event reconstruction ────────────────────────────────────────

export type ClosingEvent = {
  assetType: "stock" | "option";
  symbol: string;
  openedAt: string;
  closedAt: string;
  quantityClosed: number;
  entryPrice: number; // weighted avg cost/premium at the moment of this close
  exitPrice: number; // this close's own fill price/premium
  realizedPnL: number;
  realizedReturnPct: number; // (exit - entry) / entry — multiplier-free, so stock and options compare directly
  holdingDays: number;
  tradeSizeUSD: number; // dollar size of the CLOSING trade
  // Every transaction id that could plausibly carry a journal note for this
  // lineage: the buy(s) that built the position plus the closing trade
  // itself. Used ONLY to check set membership against a caller-supplied
  // noted-id set — never to fetch or read journal content.
  relatedTransactionIds: string[];
};

/** Replay a user's stock ledger in chronological order, emitting one
 *  ClosingEvent per sell (partial or full). Mirrors execute_trade's SQL
 *  exactly: buys recompute a weighted-average cost, sells never touch it. */
export function reconstructStockClosingEvents(transactions: Transaction[]): ClosingEvent[] {
  const bySymbol = new Map<string, { qty: number; avgCost: number; openedAt: string | null; buyIds: string[] }>();
  const sorted = [...transactions].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const events: ClosingEvent[] = [];

  for (const t of sorted) {
    const sym = t.symbol;
    const st = bySymbol.get(sym) ?? { qty: 0, avgCost: 0, openedAt: null, buyIds: [] };
    if (t.side === "buy") {
      if (st.qty <= 0) {
        st.openedAt = t.created_at;
        st.buyIds = [];
      }
      const newQty = st.qty + t.quantity;
      st.avgCost = newQty > 0 ? (st.qty * st.avgCost + t.quantity * t.price) / newQty : t.price;
      st.qty = newQty;
      st.buyIds.push(t.id);
    } else {
      // sell — avg cost is unchanged by a sell, exactly like the SQL engine.
      const entryPrice = st.avgCost;
      const qtyClosed = Math.min(t.quantity, st.qty); // defensive; ledger should never oversell
      if (qtyClosed > 0 && st.openedAt) {
        events.push({
          assetType: "stock",
          symbol: sym,
          openedAt: st.openedAt,
          closedAt: t.created_at,
          quantityClosed: qtyClosed,
          entryPrice,
          exitPrice: t.price,
          realizedPnL: (t.price - entryPrice) * qtyClosed,
          realizedReturnPct: entryPrice > 0 ? (t.price - entryPrice) / entryPrice : 0,
          holdingDays: diffDays(t.created_at, st.openedAt),
          tradeSizeUSD: t.total,
          relatedTransactionIds: [...st.buyIds, t.id],
        });
      }
      st.qty -= qtyClosed;
      if (st.qty <= 0) {
        st.qty = 0;
        st.openedAt = null;
        st.buyIds = [];
      }
    }
    bySymbol.set(sym, st);
  }
  return events;
}

/** Same replay for options. option_positions rows are DELETED the instant a
 *  contract fully closes, so — unlike stocks, where `holdings` at least
 *  persists an open position — closed option lineages can ONLY be
 *  reconstructed from option_transactions; there is no other source. All
 *  three closing sides (sell_to_close, expired, settled) count as a close. */
export function reconstructOptionClosingEvents(optionTransactions: OptionTransaction[]): ClosingEvent[] {
  const byContract = new Map<string, { contracts: number; avgPremium: number; openedAt: string | null; buyIds: string[] }>();
  const sorted = [...optionTransactions].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const events: ClosingEvent[] = [];

  for (const t of sorted) {
    const key = t.contract_id;
    const st = byContract.get(key) ?? { contracts: 0, avgPremium: 0, openedAt: null, buyIds: [] };
    if (t.side === "buy_to_open") {
      if (st.contracts <= 0) {
        st.openedAt = t.created_at;
        st.buyIds = [];
      }
      const newContracts = st.contracts + t.contracts;
      st.avgPremium = newContracts > 0 ? (st.contracts * st.avgPremium + t.contracts * t.premium) / newContracts : t.premium;
      st.contracts = newContracts;
      st.buyIds.push(t.id);
    } else {
      // sell_to_close / expired / settled — all close the position.
      const entryPrice = st.avgPremium;
      const qtyClosed = Math.min(t.contracts, st.contracts);
      if (qtyClosed > 0 && st.openedAt) {
        events.push({
          assetType: "option",
          symbol: t.symbol,
          openedAt: st.openedAt,
          closedAt: t.created_at,
          quantityClosed: qtyClosed,
          entryPrice,
          exitPrice: t.premium,
          realizedPnL: (t.premium - entryPrice) * 100 * qtyClosed,
          realizedReturnPct: entryPrice > 0 ? (t.premium - entryPrice) / entryPrice : 0,
          holdingDays: diffDays(t.created_at, st.openedAt),
          tradeSizeUSD: t.total,
          relatedTransactionIds: [...st.buyIds, t.id],
        });
      }
      st.contracts -= qtyClosed;
      if (st.contracts <= 0) {
        st.contracts = 0;
        st.openedAt = null;
        st.buyIds = [];
      }
    }
    byContract.set(key, st);
  }
  return events;
}

// ─── 1. Disposition effect ────────────────────────────────────────────────
// The single best-documented retail trading mistake: selling winners early
// while holding losers, hoping they recover. Signature = winners' average
// holding period is SHORTER than losers'.
export const MIN_CLOSES_PER_BUCKET_DISPOSITION = 5; // below this, one outlier trade dominates the average

export type DispositionData = {
  winnersN: number;
  losersN: number;
  avgHoldDaysWinners: number;
  avgHoldDaysLosers: number;
  avgReturnPctWinners: number;
  avgReturnPctLosers: number;
  soldWinnersFaster: boolean; // the disposition-effect signature
};

export function computeDispositionEffect(closes: ClosingEvent[]): MetricResult<DispositionData> {
  const winners = closes.filter((c) => c.realizedPnL > 0);
  const losers = closes.filter((c) => c.realizedPnL < 0);
  const n = Math.min(winners.length, losers.length);
  return gate(n, MIN_CLOSES_PER_BUCKET_DISPOSITION, `need at least ${MIN_CLOSES_PER_BUCKET_DISPOSITION} winning AND ${MIN_CLOSES_PER_BUCKET_DISPOSITION} losing closed trades`, () => {
    const avgHoldDaysWinners = round4(mean(winners.map((c) => c.holdingDays)));
    const avgHoldDaysLosers = round4(mean(losers.map((c) => c.holdingDays)));
    return {
      winnersN: winners.length,
      losersN: losers.length,
      avgHoldDaysWinners,
      avgHoldDaysLosers,
      avgReturnPctWinners: round4(mean(winners.map((c) => c.realizedReturnPct))),
      avgReturnPctLosers: round4(mean(losers.map((c) => c.realizedReturnPct))),
      soldWinnersFaster: avgHoldDaysWinners < avgHoldDaysLosers,
    };
  });
}

// ─── 2. Over-trading ──────────────────────────────────────────────────────
// Trade frequency itself is a neutral fact. What matters is whether
// HIGH-frequency weeks correlate with worse realized outcomes than quiet
// weeks — that's the actionable signal, not the raw count.
export const MIN_WEEKS_FOR_FREQUENCY = 4; // need a real span of weeks before "trades/week" means anything
export const MIN_CLOSES_PER_BUCKET_OVERTRADING = 5;

export type OverTradingData = {
  tradesPerWeek: number;
  weeksSpanned: number;
  activeWeekAvgReturnPct: number;
  quietWeekAvgReturnPct: number;
  activeWeekN: number;
  quietWeekN: number;
  worseWhenActive: boolean;
};

export function computeOverTrading(allTrades: { date: string }[], closes: ClosingEvent[]): MetricResult<OverTradingData> {
  const weeks = new Map<string, number>();
  for (const t of allTrades) weeks.set(isoWeekKey(t.date), (weeks.get(isoWeekKey(t.date)) ?? 0) + 1);
  const weeksSpanned = weeks.size;

  if (weeksSpanned < MIN_WEEKS_FOR_FREQUENCY) {
    return { available: false, n: weeksSpanned, minRequired: MIN_WEEKS_FOR_FREQUENCY, reason: `need trading activity across at least ${MIN_WEEKS_FOR_FREQUENCY} distinct weeks` };
  }
  const counts = [...weeks.values()];
  const med = median(counts);
  const activeWeeks = new Set([...weeks.entries()].filter(([, c]) => c > med).map(([w]) => w));

  const activeCloses = closes.filter((c) => activeWeeks.has(isoWeekKey(c.closedAt)));
  const quietCloses = closes.filter((c) => !activeWeeks.has(isoWeekKey(c.closedAt)));
  const bucketN = Math.min(activeCloses.length, quietCloses.length);

  return gate(bucketN, MIN_CLOSES_PER_BUCKET_OVERTRADING, `need at least ${MIN_CLOSES_PER_BUCKET_OVERTRADING} closed trades in both above- and at-or-below-median-activity weeks`, () => {
    const activeAvg = round4(mean(activeCloses.map((c) => c.realizedReturnPct)));
    const quietAvg = round4(mean(quietCloses.map((c) => c.realizedReturnPct)));
    return {
      tradesPerWeek: round4(allTrades.length / weeksSpanned),
      weeksSpanned,
      activeWeekAvgReturnPct: activeAvg,
      quietWeekAvgReturnPct: quietAvg,
      activeWeekN: activeCloses.length,
      quietWeekN: quietCloses.length,
      worseWhenActive: activeAvg < quietAvg,
    };
  });
}

// ─── 3. Concentration ──────────────────────────────────────────────────────
// Computed from COST BASIS (qty × avg_cost), not live market value — this
// needs zero price data, is purely derived from the ledger, and still
// answers the real question ("how much of your invested capital sits in one
// name"). Explicitly labeled as cost-basis-based wherever it's shown, since
// it can diverge from a live-market-value view after a big price move.
export const CONCENTRATION_THRESHOLD = 0.25; // "no more than a quarter in one name" — a standard, conservative diversification rule of thumb
export const MIN_SAMPLES_FOR_CONCENTRATION_HISTORY = 5; // need several distinct portfolio compositions to say anything about "how often"

export type ConcentrationData = {
  currentLargestSymbol: string | null;
  currentLargestSharePct: number; // 0..1
  historyAvailable: boolean;
  pctOfTimeOverThreshold: number | null; // 0..1, null if historyAvailable is false
  samplesN: number;
};

export function computeConcentration(transactions: Transaction[]): MetricResult<ConcentrationData> {
  const sorted = [...transactions].filter((t) => t.side === "buy" || t.side === "sell").sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (sorted.length === 0) return { available: false, n: 0, minRequired: 1, reason: "no trades yet" };

  const bySymbol = new Map<string, { qty: number; avgCost: number }>();
  const samples: number[] = []; // largest-symbol share after each trade, while portfolio is non-empty

  for (const t of sorted) {
    const st = bySymbol.get(t.symbol) ?? { qty: 0, avgCost: 0 };
    if (t.side === "buy") {
      const newQty = st.qty + t.quantity;
      st.avgCost = newQty > 0 ? (st.qty * st.avgCost + t.quantity * t.price) / newQty : t.price;
      st.qty = newQty;
    } else {
      st.qty = Math.max(0, st.qty - t.quantity);
    }
    bySymbol.set(t.symbol, st);

    const bases = [...bySymbol.values()].map((s) => s.qty * s.avgCost).filter((v) => v > 0);
    const total = bases.reduce((a, b) => a + b, 0);
    if (total > 0) samples.push(Math.max(...bases) / total);
  }

  if (samples.length === 0) return { available: false, n: 0, minRequired: 1, reason: "no open positions" };

  const finalBases = [...bySymbol.entries()].map(([sym, s]) => [sym, s.qty * s.avgCost] as const).filter(([, v]) => v > 0);
  const finalTotal = finalBases.reduce((a, [, v]) => a + v, 0);
  const largest = finalBases.length > 0 ? finalBases.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;

  return {
    available: true,
    n: samples.length,
    data: {
      currentLargestSymbol: largest ? largest[0] : null,
      currentLargestSharePct: largest && finalTotal > 0 ? round4(largest[1] / finalTotal) : 0,
      historyAvailable: samples.length >= MIN_SAMPLES_FOR_CONCENTRATION_HISTORY,
      pctOfTimeOverThreshold: samples.length >= MIN_SAMPLES_FOR_CONCENTRATION_HISTORY ? round4(samples.filter((s) => s > CONCENTRATION_THRESHOLD).length / samples.length) : null,
      samplesN: samples.length,
    },
  };
}

// ─── 4. Loss-chasing / revenge trading ────────────────────────────────────
// Does trade SIZE increase right after a loss? Compares the average dollar
// size of the next few ENTRY trades (buy / buy_to_open, any symbol)
// following a losing close against the user's overall average entry size.
//
// Deliberately scoped to ENTRIES only, both for the post-loss window and the
// baseline — "loss chasing" classically means sizing up the next BET, which
// is a buy-side action. Mixing in exits would also introduce a structural
// bias: an exit's dollar total is mechanically smaller than its matching
// entry's whenever the trade lost money (fewer dollars come back out than
// went in), which would inflate the baseline-vs-post-loss ratio for reasons
// that have nothing to do with the user's behaviour.
//
// The baseline ALSO deliberately EXCLUDES the post-loss-window trades
// themselves — otherwise a user who revenge-trades often would drag their
// own baseline up toward the post-loss average and mute the very effect
// this metric exists to detect.
export const WINDOW_TRADES_AFTER_LOSS = 3; // "the next few trades" — small enough to isolate an immediate reaction, not a whole new session
export const MIN_LOSSES_FOR_REVENGE = 5; // need several losses to pool a stable post-loss sample
export const MIN_POST_LOSS_TRADES = 10; // the pooled post-loss sample itself must also be non-trivial

export type RevengeTradingData = {
  lossesConsidered: number;
  postLossTradesN: number;
  avgPostLossTradeSizeUSD: number;
  baselineAvgTradeSizeUSD: number;
  ratio: number; // postLoss / baseline
  sizedUpAfterLoss: boolean;
};

export function computeRevengeTrading(allTrades: { date: string; totalUSD: number }[], losses: ClosingEvent[]): MetricResult<RevengeTradingData> {
  if (losses.length < MIN_LOSSES_FOR_REVENGE) {
    return { available: false, n: losses.length, minRequired: MIN_LOSSES_FOR_REVENGE, reason: `need at least ${MIN_LOSSES_FOR_REVENGE} losing closed trades` };
  }
  const sorted = [...allTrades].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  // Track post-loss trades by INDEX, not just collect their sizes — the
  // baseline below deliberately EXCLUDES them (see the type-level comment),
  // so a user who revenge-trades often doesn't drag their own baseline up
  // and mute the very effect this metric exists to catch.
  const postLossIdx = new Set<number>();
  for (const loss of losses) {
    let taken = 0;
    for (let i = 0; i < sorted.length && taken < WINDOW_TRADES_AFTER_LOSS; i++) {
      if (new Date(sorted[i].date).getTime() > new Date(loss.closedAt).getTime()) {
        postLossIdx.add(i);
        taken++;
      }
    }
  }
  const postLossSizes = [...postLossIdx].map((i) => sorted[i].totalUSD);
  return gate(postLossSizes.length, MIN_POST_LOSS_TRADES, `need at least ${MIN_POST_LOSS_TRADES} trades following a loss, pooled across all losses`, () => {
    const avgPostLoss = mean(postLossSizes);
    const baselineTrades = sorted.filter((_, i) => !postLossIdx.has(i));
    // Degenerate fallback (virtually never hit at any real trade volume):
    // if EVERY entry happens to be inside a post-loss window, there is no
    // non-post-loss trade left to compare against — fall back to the full
    // set rather than dividing by an empty baseline.
    const baseline = baselineTrades.length > 0 ? mean(baselineTrades.map((t) => t.totalUSD)) : mean(sorted.map((t) => t.totalUSD));
    return {
      lossesConsidered: losses.length,
      postLossTradesN: postLossSizes.length,
      avgPostLossTradeSizeUSD: round4(avgPostLoss),
      baselineAvgTradeSizeUSD: round4(baseline),
      ratio: baseline > 0 ? round4(avgPostLoss / baseline) : 0,
      sizedUpAfterLoss: baseline > 0 && avgPostLoss > baseline,
    };
  });
}

// ─── 5. Win rate vs. risk-adjusted return ─────────────────────────────────
// The point: a high win rate paired with a WEAK risk-adjusted return is a
// warning sign (many small wins, one huge loss), not a success. The
// risk-adjusted figure here is mean(return) / stdev(return) across closed
// trades — a simple per-trade consistency ratio, NOT a formal annualized
// Sharpe ratio (no risk-free rate, no annualization). Documented as an
// approximation deliberately, not dressed up as more rigorous than it is.
export const MIN_CLOSES_FOR_WINRATE = 8; // fewer than this and a win rate is close to a coin-flip artifact
const HIGH_WIN_RATE_THRESHOLD = 0.6;
const WEAK_RISK_ADJUSTED_THRESHOLD = 0.3; // heuristic, not derived — "return is well under 1 standard deviation of trade-to-trade noise"

export type WinRateData = {
  winRate: number; // 0..1
  avgReturnPct: number;
  stdevReturnPct: number;
  riskAdjustedReturn: number | null; // null if stdev is 0 (e.g. every trade identical, or n<2)
  warningHighWinRateWeakRiskAdjusted: boolean;
};

export function computeWinRateVsRiskAdjusted(closes: ClosingEvent[]): MetricResult<WinRateData> {
  return gate(closes.length, MIN_CLOSES_FOR_WINRATE, `need at least ${MIN_CLOSES_FOR_WINRATE} closed trades`, () => {
    const returns = closes.map((c) => c.realizedReturnPct);
    const wins = closes.filter((c) => c.realizedPnL > 0).length;
    const avgReturnPct = round4(mean(returns));
    const sd = stdev(returns);
    const riskAdjustedReturn = sd > 0 ? round4(avgReturnPct / sd) : null;
    const winRate = round4(wins / closes.length);
    return {
      winRate,
      avgReturnPct,
      stdevReturnPct: round4(sd),
      riskAdjustedReturn,
      warningHighWinRateWeakRiskAdjusted: winRate > HIGH_WIN_RATE_THRESHOLD && riskAdjustedReturn !== null && riskAdjustedReturn < WEAK_RISK_ADJUSTED_THRESHOLD,
    };
  });
}

// ─── 6. Journal correlation ────────────────────────────────────────────────
// Do trades WITH a linked journal note perform differently from those
// without? Uses ONLY set-membership against caller-supplied noted-id sets —
// the exact ids getNotedTransactionIds()/getNotedOptionTransactionIds()
// return (id-only columns, never `body`/`title`). This function never sees,
// requests, or could possibly leak journal CONTENT.
export const MIN_PER_BUCKET_JOURNAL_CORRELATION = 5;

export type JournalCorrelationData = {
  notedN: number;
  unnotedN: number;
  avgReturnPctNoted: number;
  avgReturnPctUnnoted: number;
  notedPerformedBetter: boolean;
};

export function computeJournalCorrelation(
  closes: ClosingEvent[],
  notedTransactionIds: ReadonlySet<string>,
  notedOptionTransactionIds: ReadonlySet<string>,
): MetricResult<JournalCorrelationData> {
  const isNoted = (c: ClosingEvent) => {
    const set = c.assetType === "stock" ? notedTransactionIds : notedOptionTransactionIds;
    return c.relatedTransactionIds.some((id) => set.has(id));
  };
  const noted = closes.filter(isNoted);
  const unnoted = closes.filter((c) => !isNoted(c));
  const n = Math.min(noted.length, unnoted.length);
  return gate(n, MIN_PER_BUCKET_JOURNAL_CORRELATION, `need at least ${MIN_PER_BUCKET_JOURNAL_CORRELATION} closed trades both WITH and WITHOUT a linked note`, () => {
    const avgNoted = round4(mean(noted.map((c) => c.realizedReturnPct)));
    const avgUnnoted = round4(mean(unnoted.map((c) => c.realizedReturnPct)));
    return {
      notedN: noted.length,
      unnotedN: unnoted.length,
      avgReturnPctNoted: avgNoted,
      avgReturnPctUnnoted: avgUnnoted,
      notedPerformedBetter: avgNoted > avgUnnoted,
    };
  });
}

// ─── Orchestration ─────────────────────────────────────────────────────────

export type BehavioralAnalytics = {
  disposition: MetricResult<DispositionData>;
  overTrading: MetricResult<OverTradingData>;
  concentration: MetricResult<ConcentrationData>;
  revengeTrading: MetricResult<RevengeTradingData>;
  winRate: MetricResult<WinRateData>;
  journalCorrelation: MetricResult<JournalCorrelationData>;
};

export function computeBehavioralAnalytics(input: {
  transactions: Transaction[];
  optionTransactions: OptionTransaction[];
  notedTransactionIds: ReadonlySet<string>;
  notedOptionTransactionIds: ReadonlySet<string>;
}): BehavioralAnalytics {
  const stockCloses = reconstructStockClosingEvents(input.transactions);
  const optionCloses = reconstructOptionClosingEvents(input.optionTransactions);
  const allCloses = [...stockCloses, ...optionCloses];
  const losses = allCloses.filter((c) => c.realizedPnL < 0);

  const allTradesForFrequency = [
    ...input.transactions.map((t) => ({ date: t.created_at })),
    ...input.optionTransactions.map((t) => ({ date: t.created_at })),
  ];
  const entryTradesForRevenge = [
    ...input.transactions.filter((t) => t.side === "buy").map((t) => ({ date: t.created_at, totalUSD: t.total })),
    ...input.optionTransactions.filter((t) => t.side === "buy_to_open").map((t) => ({ date: t.created_at, totalUSD: t.total })),
  ];

  return {
    disposition: computeDispositionEffect(allCloses),
    overTrading: computeOverTrading(allTradesForFrequency, allCloses),
    concentration: computeConcentration(input.transactions),
    revengeTrading: computeRevengeTrading(entryTradesForRevenge, losses),
    winRate: computeWinRateVsRiskAdjusted(allCloses),
    journalCorrelation: computeJournalCorrelation(allCloses, input.notedTransactionIds, input.notedOptionTransactionIds),
  };
}
