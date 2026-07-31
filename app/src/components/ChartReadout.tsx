import { cn } from "@/lib/utils";
import { fmtUSD, fmtPct } from "@/lib/mockData";
import type { RangeReadout } from "@/lib/chartReadout";

/** "Past month: +$123.45 (+1.23%)" + a muted "Range: $LOW – $HIGH", matching
 *  the header day-change's sign/color/format convention. */
export function RangeChangeReadout({ label, readout }: { label: string; readout: RangeReadout | null }) {
  if (!readout) return null;
  const up = readout.changeAbs >= 0;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className={cn("text-sm font-medium tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
        {label}: {up ? "+" : "−"}
        {fmtUSD(Math.abs(readout.changeAbs))} ({fmtPct(readout.changePct)})
      </span>
      <span className="text-xs text-muted-foreground tabular">
        Range: {fmtUSD(readout.low)} – {fmtUSD(readout.high)}
      </span>
    </div>
  );
}
