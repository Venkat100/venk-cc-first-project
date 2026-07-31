// Pure chart-readout math (no React) shared by LivePriceChart and
// PortfolioValueChart — computes from a series ALREADY loaded, never fetches.

export type SeriesPoint = { t: string; v: number };

export type RangeReadout = {
  startV: number;
  endV: number;
  changeAbs: number;
  changePct: number;
  low: number;
  high: number;
};

/**
 * First-vs-last change + low/high over a window of points. Pass a partial
 * slice (e.g. up to a scrub cursor) to get a "start → cursor" readout instead
 * of the full-window one — same function, smaller input.
 *
 * `overrideStart` measures change against a value other than the window's
 * first point — e.g. previous close for an intraday "Today" readout, so it
 * agrees with a header day-change computed the same way. When given, it's
 * also folded into the low/high range.
 */
export function computeRangeReadout(points: SeriesPoint[], overrideStart?: number): RangeReadout | null {
  if (points.length === 0) return null;
  const startV = overrideStart ?? points[0].v;
  const endV = points[points.length - 1].v;
  const changeAbs = endV - startV;
  const changePct = startV !== 0 ? (changeAbs / startV) * 100 : 0;

  let low = points[0].v;
  let high = points[0].v;
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue;
    if (p.v < low) low = p.v;
    if (p.v > high) high = p.v;
  }
  if (overrideStart !== undefined && Number.isFinite(overrideStart)) {
    if (overrideStart < low) low = overrideStart;
    if (overrideStart > high) high = overrideStart;
  }

  return { startV, endV, changeAbs, changePct, low, high };
}

/** Plain-word labels for the readout ("Past month", never the raw range code). */
export const RANGE_LABEL: Record<string, string> = {
  "1D": "Today",
  "1W": "Past week",
  "1M": "Past month",
  "3M": "Past 3 months",
  "1Y": "Past year",
  ALL: "All time",
};
