import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { cn } from "@/lib/utils";
import { fmtUSD } from "@/lib/mockData";
import { getCandles } from "@/lib/marketData";
import { useMarketLive } from "@/lib/marketData/useMarketLive";
import type { Range, Quote } from "@/lib/marketData/types";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { RangeChangeReadout } from "@/components/ChartReadout";
import { computeRangeReadout, RANGE_LABEL, type RangeReadout } from "@/lib/chartReadout";
import { LineChart } from "lucide-react";

const RANGES: Range[] = ["1D", "1W", "1M", "3M", "1Y", "ALL"];

/** Stock-detail price chart driven by REAL historical candles (getCandles).
 *  `quote` (already fetched by the parent for the header) is reused — never
 *  refetched here — so the 1D readout can agree with the header day-change
 *  and the chart's right edge can reflect the live price. */
export function LivePriceChart({ symbol, height = 320, defaultRange = "3M", quote }: { symbol: string; height?: number; defaultRange?: Range; quote?: Quote }) {
  const [range, setRange] = useState<Range>(defaultRange);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  useEffect(() => setHoverIdx(null), [range, symbol]);

  // 1D only: the chart extends through the trading day as new 5-min bars
  // arrive server-side. Poll 60s (client) against the candles' 5-min server
  // TTL (cache.server.ts's TTL.candles) — at most 1 provider call per 5min
  // per (symbol,1D) combination, however many clients are polling it; the
  // 60s client cadence just controls how promptly a NEW bar (once the
  // provider has actually produced one) shows up here, not how often the
  // provider itself gets hit — most 60s ticks land within the same 5min
  // cache window and cost nothing extra. Other ranges never poll (candles
  // TTL=5m either way, but "does 3M drift mid-view" isn't the problem this
  // step exists to solve). Gated by useMarketLive, same as quotes.
  const CANDLE_POLL_MS = 60_000;
  const { isLive } = useMarketLive();
  const candlesQ = useQuery({
    queryKey: ["candles", symbol, range],
    queryFn: () => getCandles(symbol, range),
    staleTime: 5 * 60_000,
    refetchInterval: range === "1D" && isLive ? CANDLE_POLL_MS : false,
  });

  const rawData = useMemo(() => (candlesQ.data ?? []).map((c) => ({ t: c.t, price: c.close })), [candlesQ.data]);

  // For 1D, swap the last bar's close for the live quote price so the line's
  // right edge — and the readout's endpoint — match the header, not a
  // possibly-stale 5-minute bar.
  const data = useMemo(() => {
    if (range !== "1D" || !quote || rawData.length === 0) return rawData;
    return [...rawData.slice(0, -1), { t: new Date().toISOString(), price: quote.price }];
  }, [rawData, range, quote]);

  const first = data[0]?.price ?? 0;
  const last = data[data.length - 1]?.price ?? 0;
  const up = last >= first;
  const stroke = up ? "var(--color-gain)" : "var(--color-loss)";
  const gradId = `lg-${symbol}-${range}`;

  // Previous close, used only as the 1D readout's baseline (so it agrees with
  // the header, which is also measured vs. previous close).
  const prevClose = quote?.previousClose ?? (quote ? quote.price - quote.dayChange : undefined);
  const referenceY = range === "1D" && prevClose != null ? prevClose : first;

  const readout: RangeReadout | null = useMemo(() => {
    const points = data.map((d) => ({ t: d.t, v: d.price }));
    if (hoverIdx !== null) {
      // Scrubbing: "start → cursor" — for 1D, start is still previous close.
      const slice = points.slice(0, hoverIdx + 1);
      return computeRangeReadout(slice, range === "1D" ? prevClose : undefined);
    }
    // Resting state, 1D: reuse the header's own numbers exactly (no
    // independent recompute) so they're guaranteed to agree, not just close.
    if (range === "1D" && quote) {
      const seriesReadout = computeRangeReadout(points);
      return {
        startV: prevClose ?? quote.price - quote.dayChange,
        endV: quote.price,
        changeAbs: quote.dayChange,
        changePct: quote.dayChangePct,
        low: quote.low != null ? Math.min(quote.low, quote.price) : (seriesReadout?.low ?? quote.price),
        high: quote.high != null ? Math.max(quote.high, quote.price) : (seriesReadout?.high ?? quote.price),
      };
    }
    return computeRangeReadout(points);
  }, [data, hoverIdx, range, quote, prevClose]);

  return (
    <div className="w-full">
      <div style={{ height }} className="w-full">
        {candlesQ.isLoading ? (
          <LoadingState label="Loading price history…" />
        ) : candlesQ.isError ? (
          <ErrorState message="Couldn't load price history. The provider may be rate-limited — try again shortly." />
        ) : data.length === 0 ? (
          <EmptyState icon={LineChart} title="No price history" description="No candles were returned for this range." />
        ) : (
          <ResponsiveContainer>
            <AreaChart
              data={data}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              onMouseMove={(state) => {
                const idx = (state as { activeTooltipIndex?: number; isTooltipActive?: boolean })?.activeTooltipIndex;
                if (typeof idx === "number") setHoverIdx(idx);
              }}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" hide />
              <YAxis domain={["dataMin - 2", "dataMax + 2"]} hide />
              <Tooltip
                cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, color: "var(--color-popover-foreground)", fontSize: 12 }}
                labelFormatter={(v) =>
                  // Daily bars are UTC-midnight timestamps with no real intraday
                  // time — format them in UTC so the date shown matches the bar
                  // (a local-time render can shift it a day in TZs behind UTC).
                  // 1D bars carry a real intraday time, so those stay local.
                  range === "1D"
                    ? new Date(v as string).toLocaleString()
                    : new Date(v as string).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })
                }
                formatter={(v: number) => [fmtUSD(v), "Price"]}
                isAnimationActive={false}
              />
              <ReferenceLine y={referenceY} stroke="var(--color-border)" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="price"
                stroke={stroke}
                strokeWidth={2}
                fill={`url(#${gradId})`}
                activeDot={{ r: 5, stroke: "var(--color-background)", strokeWidth: 2, fill: stroke }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {data.length > 0 && (
        <div className="mt-2">
          <RangeChangeReadout label={hoverIdx !== null ? "Selected" : RANGE_LABEL[range]} readout={readout} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium tabular transition-colors",
              r === range ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}
