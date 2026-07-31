import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, History, AlertTriangle, Eye } from "lucide-react";
import type { StockInsight, MarketBrief, InsightLean } from "@/lib/insights/types";

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

      <Bullets title="Risks" items={insight.risks} icon={AlertTriangle} />

      {insight.watch_for && (
        <p className="flex items-start gap-1.5 text-sm">
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span><span className="font-medium">Watch for:</span> {insight.watch_for}</span>
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">
        Generated {new Date(insight.generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · refreshes daily
      </p>
      <AiDisclaimer />
    </div>
  );
}

export function MarketBriefBody({ brief, createdAt }: { brief: MarketBrief; createdAt: string }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium leading-relaxed">{brief.headline_takeaway}</p>
      {brief.items?.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
          {brief.items.map((it, i) => (
            <li key={i} className="px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold">{it.symbol}</span>
                <span className="text-sm text-foreground/90">{it.one_line_what_happened}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{it.why_it_matters}</p>
            </li>
          ))}
        </ul>
      )}
      {brief.overall_note && <p className="text-sm text-muted-foreground">{brief.overall_note}</p>}
      <p className="text-[11px] text-muted-foreground">For {new Date(createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
      <AiDisclaimer />
    </div>
  );
}
