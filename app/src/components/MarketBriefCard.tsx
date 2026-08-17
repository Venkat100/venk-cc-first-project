import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Newspaper, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { AiDisclaimer } from "@/components/InsightUI";
import { getTodaysBrief } from "@/lib/insights/api";
import { formatCalendarDate } from "@/lib/format/datetime";
import type { MarketBrief } from "@/lib/insights/types";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

// ~6.5s — slower than the auth showcase's 4s (denser reading: a headline
// PLUS a "why it matters" line PLUS possibly a source link, vs. a single
// short sentence there). Same interaction conventions as
// AuthFeatureShowcase.tsx throughout this file on purpose, not reinvented:
// hover-pause, prefers-reduced-motion forces a single static item with the
// timer never created at all, and a remount-keyed fade on item change.
const ROTATE_MS = 6500;

export function MarketBriefCard({ hasTracked }: { hasTracked: boolean }) {
  const briefQ = useQuery({ queryKey: ["todaysBrief"], queryFn: getTodaysBrief });
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const items = briefQ.data?.brief.items ?? [];
  const n = items.length;

  // A new day's brief (or the query refetching) can arrive with fewer items
  // than the index the user had paged to — snap back to the first item
  // rather than rendering `undefined`.
  useEffect(() => {
    setIndex(0);
  }, [briefQ.data?.createdAt]);

  useEffect(() => {
    if (reducedMotion || paused || n <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % n), ROTATE_MS);
    return () => clearInterval(id);
  }, [reducedMotion, paused, n]);

  const activeIndex = n > 0 ? index % n : 0;
  const showControls = !reducedMotion && n > 1;
  // Arrows themselves still work under reduced motion (per spec) — only the
  // auto-rotation and the fade transition are suppressed. Controls are
  // hidden entirely for a single item OR when there's nothing to page
  // through, never shown dead/disabled.
  const showArrows = n > 1;

  function goTo(next: number) {
    setPaused(true);
    setIndex(((next % n) + n) % n);
  }

  return (
    <Card onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Newspaper className="h-4 w-4 text-[color:var(--color-primary)]" /> Today's market brief
          </CardTitle>
          {showArrows && (
            <div className="flex items-center gap-1">
              <span className="mr-1 text-xs tabular-nums text-muted-foreground">
                {activeIndex + 1} / {n}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Previous item" onClick={() => goTo(activeIndex - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Next item" onClick={() => goTo(activeIndex + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {briefQ.isLoading ? (
          <LoadingState label="Loading your brief…" />
        ) : briefQ.isError ? (
          <ErrorState message="Couldn't load your brief right now." />
        ) : briefQ.data ? (
          <BriefBody brief={briefQ.data.brief} createdAt={briefQ.data.createdAt} activeIndex={activeIndex} animate={showControls} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {hasTracked
                ? "Your AI market brief arrives after each market day — a quick read on the news moving your holdings and watchlist."
                : "Add holdings or watchlist tickers and your AI market brief — a quick read on the news moving them — will arrive after each market day."}
            </p>
            <AiDisclaimer />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BriefBody({ brief, createdAt, activeIndex, animate }: { brief: MarketBrief; createdAt: string; activeIndex: number; animate: boolean }) {
  const item = brief.items?.[activeIndex];
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium leading-relaxed">{brief.headline_takeaway}</p>

      {item && (
        <div key={animate ? activeIndex : "static"} className={cn("rounded-lg border border-border p-3", animate && "animate-in fade-in duration-200")}>
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {item.isMarketWide ? "Market-wide" : "Your holdings"}
          </p>
          <div className="flex items-baseline gap-2">
            <Link to="/app/stock/$symbol" params={{ symbol: item.symbol }} className="font-semibold hover:underline">
              {item.symbol}
            </Link>
            <span className="text-sm text-foreground/90">{item.one_line_what_happened}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{item.why_it_matters}</p>
          {item.article_url && (
            <a
              href={item.article_url}
              target="_blank"
              rel="noopener noreferrer"
              className="group mt-2 inline-flex items-center gap-1 text-xs text-[color:var(--color-primary)] hover:underline"
            >
              Read the full story{item.article_source ? ` — ${item.article_source}` : ""}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          )}
        </div>
      )}

      {brief.overall_note && <p className="text-sm text-muted-foreground">{brief.overall_note}</p>}
      {/* createdAt is a date-only (UTC-midnight) string — formatCalendarDate
          renders it in UTC regardless of viewer, so it can't shift to the
          wrong day in a timezone behind UTC (same class of bug as H4b's
          simulator date fix; see lib/format/datetime.ts's header). */}
      <p className="text-[11px] text-muted-foreground">For {formatCalendarDate(createdAt, { month: "short", day: "numeric" })}</p>
      <AiDisclaimer />
    </div>
  );
}
