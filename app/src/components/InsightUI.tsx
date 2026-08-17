import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, History, AlertTriangle, Eye, BarChart3 } from "lucide-react";
import { fmtPct } from "@/lib/mockData";
import { formatInstant } from "@/lib/format/datetime";
import type { StockInsight, InsightLean, MeasuredHistory } from "@/lib/insights/types";

const LEAN: Record<InsightLean, { label: string; cls: string; icon: typeof TrendingUp }> = {
  bullish: { label: "Bullish lean", cls: "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]", icon: TrendingUp },
  bearish: { label: "Bearish lean", cls: "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]", icon: TrendingDown },
  neutral: { label: "Neutral", cls: "bg-muted text-muted-foreground", icon: Minus },
};

export function LeanBadge({ lean, confidence }: { lean: InsightLean; confidence: string }) {
  const m = LEAN[lean] ?? LEAN.neutral;
  const Icon = m.icon;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium", m.cls)}>
        <Icon className="h-3.5 w-3.5" /> {m.label}
      </span>
      <span className="text-xs text-muted-foreground">· {confidence} confidence</span>
    </span>
  );
}

/** The persistent "analysis, not advice" disclaimer shown wherever AI output appears. */
export function AiDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("text-[11px] leading-relaxed text-muted-foreground", className)}>
      AI-generated educational analysis based on live news and historical market patterns — <span className="font-medium">not financial advice</span>. Markets are unpredictable.
    </p>
  );
}

function Bullets({ title, items, icon: Icon }: { title: string; items: string[]; icon: typeof History }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"><Icon className="h-3.5 w-3.5" /> {title}</p>
      <ul className="space-y-1 text-sm">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2"><span className="text-muted-foreground">•</span><span>{it}</span></li>
        ))}
      </ul>
    </div>
  );
}

/** "Measured history" — the EVENT STUDY block. Deliberately renders the
 *  MeasuredHistory numbers directly (not anything Claude wrote) so what's on
 *  screen is exactly what was measured from price history. Degrades honestly
 *  when there isn't enough same-stock precedent, instead of hiding the block
 *  or showing a fabricated figure. */
function MeasuredHistoryBlock({ symbol, mh }: { symbol: string; mh: MeasuredHistory | null }) {
  if (!mh) return null;
  const dirWord = mh.direction === "up" ? "gains" : "drops";

  if (mh.events_found === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"><BarChart3 className="h-3.5 w-3.5" /> Measured history</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          No comparable single-day {dirWord} found in {symbol}'s available price history ({mh.window_years > 0 ? `~${mh.window_years}y` : "limited history"}) — not enough precedent to measure a forward pattern.
        </p>
      </div>
    );
  }

  const small = mh.events_found < 5;
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"><BarChart3 className="h-3.5 w-3.5" /> Measured history</p>
      <p className="text-sm leading-relaxed text-foreground/90">
        After {mh.events_found} similar single-day {dirWord} in the past {mh.window_years} years, {symbol} was higher a month later{" "}
        <span className="font-medium text-foreground">{Math.round((mh.pct_positive_1m ?? 0) * 100)}% of the time</span>
        {" "}(median {fmtPct((mh.median_fwd_1m ?? 0) * 100, 1)}, range {fmtPct((mh.worst_1m ?? 0) * 100, 1)} to {fmtPct((mh.best_1m ?? 0) * 100, 1)}).
        {small && " Small sample — treat this as a loose pattern, not a strong signal."}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">Measured directly from {symbol}'s own price history — not AI-recalled.</p>
    </div>
  );
}

export function StockInsightBody({ insight }: { insight: StockInsight }) {
  return (
    <div className="space-y-4">
      <LeanBadge lean={insight.lean} confidence={insight.confidence} />
      <p className="text-sm leading-relaxed">{insight.summary}</p>

      <Bullets title="Key drivers" items={insight.drivers} icon={TrendingUp} />

      {insight.historical_parallel && (
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"><History className="h-3.5 w-3.5" /> Historical rhyme</p>
          <p className="text-sm leading-relaxed text-foreground/90">{insight.historical_parallel}</p>
        </div>
      )}

      <MeasuredHistoryBlock symbol={insight.symbol} mh={insight.measured_history} />

      <Bullets title="Risks" items={insight.risks} icon={AlertTriangle} />

      {insight.watch_for && (
        <p className="flex items-start gap-1.5 text-sm">
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span><span className="font-medium">Watch for:</span> {insight.watch_for}</span>
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">
        Generated {formatInstant(insight.generatedAt)} · refreshes daily
      </p>
      <AiDisclaimer />
    </div>
  );
}
