// Normalized (% change since scenario start) multi-line chart for a
// scenario run. Every line is built ONLY from the candle series the server
// already sliced to the current cutoff date (lib/scenarios/functions.ts,
// getScenarioMarketDataFn) — this component has no way to render a date it
// wasn't handed, which is exactly the point.

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import type { Candle } from "@/lib/marketData/types";
import { fmtPct } from "@/lib/mockData";
import { formatCalendarDate } from "@/lib/format/datetime";

const PALETTE = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"];

export type ScenarioChartProps = {
  series: Record<string, Candle[]>;
  symbols: string[]; // tradeable symbols, display order
  benchmarkSymbol: string;
};

type ChartPoint = { t: string; [symbol: string]: number | string };

export function ScenarioChart({ series, symbols, benchmarkSymbol }: ScenarioChartProps) {
  const allSymbols = [...symbols, benchmarkSymbol];
  const baseline: Record<string, number> = {};
  for (const s of allSymbols) {
    const first = series[s]?.[0];
    if (first) baseline[s] = first.close;
  }

  // Merge every symbol's series into one date-keyed point array of % returns.
  const dateSet = new Set<string>();
  for (const s of allSymbols) for (const c of series[s] ?? []) dateSet.add(c.t.slice(0, 10));
  const dates = [...dateSet].sort();

  const closeByDate: Record<string, Map<string, number>> = {};
  for (const s of allSymbols) {
    const m = new Map<string, number>();
    for (const c of series[s] ?? []) m.set(c.t.slice(0, 10), c.close);
    closeByDate[s] = m;
  }

  const last: Record<string, number> = {};
  const points: ChartPoint[] = dates.map((d) => {
    const pt: ChartPoint = { t: d };
    for (const s of allSymbols) {
      const close = closeByDate[s].get(d);
      if (close != null) last[s] = close;
      const base = baseline[s];
      if (base != null && last[s] != null) {
        pt[s] = +(((last[s] - base) / base) * 100).toFixed(3);
      }
    }
    return pt;
  });

  return (
    <div className="h-[320px] sm:h-[380px]">
      <ResponsiveContainer>
        <LineChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="t" tickFormatter={(v) => formatCalendarDate(v, { month: "short", year: "2-digit" })} stroke="var(--color-muted-foreground)" fontSize={11} minTickGap={32} />
          <YAxis tickFormatter={(v) => `${v}%`} stroke="var(--color-muted-foreground)" fontSize={11} width={50} />
          <Tooltip
            contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
            labelFormatter={(v) => formatCalendarDate(v as string)}
            formatter={(v: number, n) => [fmtPct(v), n]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {symbols.map((s, i) => (
            <Line key={s} type="monotone" dataKey={s} stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls />
          ))}
          <Line type="monotone" dataKey={benchmarkSymbol} stroke="var(--color-foreground)" strokeWidth={2.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls name={`${benchmarkSymbol} (benchmark)`} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
