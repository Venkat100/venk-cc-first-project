// Pure benchmark math for the agent performance chart (no React, unit-tested).
//
// Indexes an S&P 500 (SPY) line to the SAME starting point as the agent's value
// at the LEFT EDGE of the visible window, then scales it by SPY's price ratio:
//
//     spyLine(d) = agentValue(firstVisibleDate) × ( spyClose(d) / spyClose(d0) )
//
// i.e. "if I'd put this same amount into the S&P 500 on day one of this window,
// where would I be vs the agent?" Both lines therefore start equal, so the gap
// at the right edge IS the out/under-performance.
//
// Limitation (documented): mid-window deposits/withdrawals into the agent make
// the ABSOLUTE-dollar comparison approximate — the return-% readout is the
// honest headline. SPY closes are forward-filled to cover weekends/holidays.

export type ValuePoint = { t: string; v: number };
export type SpyPoint = { t: string; close: number };

export type BenchmarkResult = {
  available: boolean;
  data: Array<{ t: string; v: number; spy?: number }>;
  agentReturnPct: number;
  spyReturnPct: number;
  diffPct: number; // agent − spy; > 0 = beating the market
};

const dayOf = (iso: string) => iso.slice(0, 10);

/** Index a SPY series to the agent's window. `points` are the visible window. */
export function indexBenchmark(points: ValuePoint[], spy: SpyPoint[]): BenchmarkResult {
  const data = points.map((p) => ({ t: p.t, v: p.v }));
  const agentFirst = points[0]?.v ?? 0;
  const agentLast = points[points.length - 1]?.v ?? 0;
  const agentReturnPct = agentFirst > 0 ? ((agentLast - agentFirst) / agentFirst) * 100 : 0;

  if (points.length < 2 || spy.length === 0) {
    return { available: false, data, agentReturnPct, spyReturnPct: 0, diffPct: 0 };
  }

  const sorted = spy
    .map((s) => ({ d: dayOf(s.t), close: s.close }))
    .filter((s) => Number.isFinite(s.close) && s.close > 0)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  // Latest SPY close on or before `date` (forward-fill across non-trading days).
  const onOrBefore = (date: string): number | undefined => {
    let lo = 0, hi = sorted.length - 1, ans: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].d <= date) { ans = sorted[mid].close; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  const v0 = agentFirst;
  const spy0 = onOrBefore(dayOf(points[0].t)) ?? sorted[0]?.close;
  if (!spy0 || spy0 <= 0 || v0 <= 0) {
    return { available: false, data, agentReturnPct, spyReturnPct: 0, diffPct: 0 };
  }

  const withSpy = points.map((p) => {
    const sp = onOrBefore(dayOf(p.t)) ?? spy0;
    return { t: p.t, v: p.v, spy: Math.round(v0 * (sp / spy0) * 100) / 100 };
  });
  const spyLast = withSpy[withSpy.length - 1].spy as number;
  const spyReturnPct = ((spyLast - v0) / v0) * 100;

  return { available: true, data: withSpy, agentReturnPct, spyReturnPct, diffPct: agentReturnPct - spyReturnPct };
}
