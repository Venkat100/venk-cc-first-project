import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { cn } from "@/lib/utils";
import { fmtUSD } from "@/lib/mockData";
import { getCandles } from "@/lib/marketData";
import type { Range } from "@/lib/marketData/types";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { LineChart } from "lucide-react";

const RANGES: Range[] = ["1D", "1W", "1M", "3M", "1Y", "ALL"];

/** Stock-detail price chart driven by REAL historical candles (getCandles). */
export function LivePriceChart({ symbol, height = 320, defaultRange = "3M" }: { symbol: string; height?: number; defaultRange?: Range }) {
  const [range, setRange] = useState<Range>(defaultRange);
  const candlesQ = useQuery({
    queryKey: ["candles", symbol, range],
    queryFn: () => getCandles(symbol, range),
    staleTime: 5 * 60_000,
  });

  const data = useMemo(() => (candlesQ.data ?? []).map((c) => ({ t: c.t, price: c.close })), [candlesQ.data]);
  const first = data[0]?.price ?? 0;
  const last = data[data.length - 1]?.price ?? 0;
  const up = last >= first;
  const stroke = up ? "var(--color-gain)" : "var(--color-loss)";
  const gradId = `lg-${symbol}-${range}`;

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
            <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                labelFormatter={(v) => new Date(v as string).toLocaleString()}
                formatter={(v: number) => [fmtUSD(v), "Price"]}
              />
              <ReferenceLine y={first} stroke="var(--color-border)" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="price" stroke={stroke} strokeWidth={2} fill={`url(#${gradId})`} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
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
