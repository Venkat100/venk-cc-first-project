import { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { cn } from "@/lib/utils";
import { fmtUSD } from "@/lib/mockData";
import { LoadingState, ErrorState } from "@/components/DataStates";
import type { Snapshot } from "@/lib/snapshots/queries";
import { indexBenchmark, type SpyPoint } from "@/components/portfolioBenchmark";
import { LineChart } from "lucide-react";

export type Benchmark = { series: SpyPoint[]; loading?: boolean; error?: boolean };

type ChartRange = "1W" | "1M" | "3M" | "1Y" | "ALL";
const RANGES: ChartRange[] = ["1W", "1M", "3M", "1Y", "ALL"];
const RANGE_DAYS: Record<ChartRange, number> = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365, ALL: Infinity };

const STARTING_CAPITAL = 100000;

/**
 * Real portfolio-value chart from daily snapshots, with a live "now" point so
 * the end of the chart matches the headline value. Builds up day by day.
 * `baseline` is the dashed reference line (default $100k for the main account;
 * the agent passes its allocated amount).
 */
export function PortfolioValueChart({
  snapshots,
  liveTotal,
  loading,
  error,
  height = 300,
  baseline = STARTING_CAPITAL,
  benchmark,
}: {
  snapshots: Snapshot[];
  liveTotal: number;
  loading?: boolean;
  error?: string;
  height?: number;
  baseline?: number;
  benchmark?: Benchmark;
}) {
  const [range, setRange] = useState<ChartRange>("1M");

  // Snapshot history + a live point for today (replaces today's stored point).
  const allPoints = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const pts = snapshots.map((s) => ({ t: s.captured_at, v: s.total_value }));
    if (pts.length && pts[pts.length - 1].t === today) pts[pts.length - 1] = { t: today, v: liveTotal };
    else pts.push({ t: today, v: liveTotal });
    return pts;
  }, [snapshots, liveTotal]);

  const windowPoints = useMemo(() => {
    const days = RANGE_DAYS[range];
    if (days === Infinity) return allPoints;
    const cutoff = Date.now() - days * 86_400_000;
    const filtered = allPoints.filter((p) => new Date(p.t).getTime() >= cutoff);
    return filtered.length >= 2 ? filtered : allPoints.slice(-2);
  }, [allPoints, range]);

  // S&P 500 benchmark, indexed to the agent's value at the window's left edge.
  const bench = useMemo(
    () => (benchmark && benchmark.series.length ? indexBenchmark(windowPoints, benchmark.series) : null),
    [benchmark, windowPoints],
  );
  const data = bench?.available ? bench.data : windowPoints;

  const first = data[0]?.v ?? 0;
  const last = data[data.length - 1]?.v ?? 0;
  const up = last >= first;
  const stroke = up ? "var(--color-gain)" : "var(--color-loss)";

  const shortHistory = allPoints.length < 2;

  return (
    <div className="w-full">
      <div style={{ height }} className="w-full">
        {loading ? (
          <LoadingState label="Loading your value history…" />
        ) : error ? (
          <ErrorState message={error} />
        ) : shortHistory ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <LineChart className="h-8 w-8 opacity-60" />
            <p className="text-sm">Your value chart builds day by day as you trade.</p>
            <p className="text-xs">Today: <span className="tabular text-foreground">{fmtUSD(liveTotal)}</span></p>
            {benchmark && <p className="text-xs">The S&amp;P 500 benchmark line appears as history grows.</p>}
          </div>
        ) : (
          <ResponsiveContainer>
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pv-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })} stroke="var(--color-muted-foreground)" fontSize={11} minTickGap={40} />
              <YAxis domain={["dataMin - 100", "dataMax + 100"]} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} stroke="var(--color-muted-foreground)" fontSize={11} width={48} />
              <Tooltip
                cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }}
                contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                formatter={(v: number, name) => [fmtUSD(v), name === "spy" ? "S&P 500 (indexed)" : "Portfolio value"]}
              />
              {/* Baseline reference so gains/losses vs the starting amount are obvious. */}
              <ReferenceLine y={baseline} stroke="var(--color-border)" strokeDasharray="4 4" />
              <Area type="monotone" dataKey="v" stroke={stroke} strokeWidth={2} fill="url(#pv-grad)" />
              {bench?.available && (
                <Area type="monotone" dataKey="spy" stroke="var(--color-muted-foreground)" strokeWidth={1.5} strokeDasharray="5 4" fill="none" dot={false} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Beat/lag readout vs the S&P 500 over the visible window. */}
      {!loading && !error && !shortHistory && benchmark && (
        <BenchmarkReadout bench={bench} loading={benchmark.loading} failed={benchmark.error} />
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

const fmtSigned = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;

function BenchmarkReadout({ bench, loading, failed }: { bench: ReturnType<typeof indexBenchmark> | null; loading?: boolean; failed?: boolean }) {
  if (failed) return <p className="mt-2 text-[11px] text-muted-foreground">S&amp;P 500 benchmark unavailable right now.</p>;
  if (loading && !bench?.available) return <p className="mt-2 text-[11px] text-muted-foreground">Loading S&amp;P 500 benchmark…</p>;
  if (!bench?.available) return null;

  const beating = bench.diffPct >= 0;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded bg-[color:var(--color-primary)]" /> Agent
        <span className="tabular font-medium text-foreground">{fmtSigned(bench.agentReturnPct)}</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="inline-block h-0 w-4 border-t border-dashed border-[color:var(--color-muted-foreground)]" /> S&amp;P 500
        <span className="tabular font-medium">{fmtSigned(bench.spyReturnPct)}</span>
      </span>
      <span className={cn("tabular font-medium", beating ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
        {beating ? "Beating" : "Lagging"} the market by {Math.abs(bench.diffPct).toFixed(1)}%
      </span>
    </div>
  );
}
