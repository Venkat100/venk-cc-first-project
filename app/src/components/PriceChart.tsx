import { useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { cn } from "@/lib/utils";
import { generateHistory, type Range, fmtUSD } from "@/lib/mockData";

const RANGES: Range[] = ["1D", "1W", "1M", "3M", "1Y", "ALL"];

type Props = {
  symbol: string;
  endPrice?: number;
  height?: number;
  className?: string;
  defaultRange?: Range;
};

export function PriceChart({ symbol, endPrice, height = 320, className, defaultRange = "1M" }: Props) {
  const [range, setRange] = useState<Range>(defaultRange);
  const data = useMemo(() => generateHistory(symbol, range, endPrice), [symbol, range, endPrice]);
  const first = data[0]?.price ?? 0;
  const last = data[data.length - 1]?.price ?? 0;
  const up = last >= first;
  const stroke = up ? "var(--color-gain)" : "var(--color-loss)";
  const gradId = `g-${symbol}-${range}`;

  return (
    <div className={cn("w-full", className)}>
      <div style={{ height }} className="w-full">
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
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                color: "var(--color-popover-foreground)",
                fontSize: 12,
              }}
              labelFormatter={(v) => new Date(v as string).toLocaleString()}
              formatter={(v: number) => [fmtUSD(v), "Price"]}
            />
            <ReferenceLine y={first} stroke="var(--color-border)" strokeDasharray="3 3" />
            <Area type="monotone" dataKey="price" stroke={stroke} strokeWidth={2} fill={`url(#${gradId})`} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium tabular transition-colors",
              r === range
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Sparkline({ data, up, height = 36, width = 96 }: { data: number[]; up: boolean; height?: number; width?: number }) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");
  const stroke = up ? "var(--color-gain)" : "var(--color-loss)";
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline fill="none" stroke={stroke} strokeWidth={1.5} points={points} />
    </svg>
  );
}
