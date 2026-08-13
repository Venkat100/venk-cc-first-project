// PLAN.md §6 step 7 (B2) — behavioural analytics UI. Own dedicated page
// (not a Portfolio section): six distinct patterns each need real
// explanatory copy plus a below-threshold state, which would clutter
// Portfolio's already-dense holdings/allocation/transaction-history layout.
// Matches the precedent of Margin and Journal, which also got their own
// pages once they had enough content and a genuinely different "mode" of
// use (a periodic check-in, not a glance at current state) — and gives
// step 8 (adaptive coaching) a natural home to build on.
//
// NO AI calls anywhere in this file or its data path — every number here is
// deterministic arithmetic over the user's own ledger (lib/behavioral/metrics.ts).

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTrackOnce } from "@/lib/analytics/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { getBehavioralAnalytics } from "@/lib/behavioral/api";
import { getExperienceLevel } from "@/lib/coaching/api";
import { pickTopLesson } from "@/lib/coaching/priority";
import type { ExperienceLevel, ExperienceLevelResult } from "@/lib/coaching/level";
import {
  dispositionCard,
  overTradingCard,
  concentrationCard,
  revengeTradingCard,
  winRateCard,
  journalCorrelationCard,
  CARD_BUILDERS,
  type Card as PatternCard,
} from "@/lib/behavioral/copy";
import { Compass, Sparkles, GraduationCap, CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/app/coach")({
  head: () => ({ meta: [{ title: "Coach · PaperTrader" }] }),
  component: Coach,
});

function Coach() {
  useTrackOnce("coach_visited");

  const q = useQuery({ queryKey: ["behavioralAnalytics"], queryFn: getBehavioralAnalytics });
  const levelQ = useQuery({ queryKey: ["experienceLevel"], queryFn: getExperienceLevel });

  const cards: PatternCard[] | undefined = q.data
    ? [
        dispositionCard(q.data.disposition),
        overTradingCard(q.data.overTrading),
        concentrationCard(q.data.concentration),
        revengeTradingCard(q.data.revengeTrading),
        winRateCard(q.data.winRate),
        journalCorrelationCard(q.data.journalCorrelation),
      ]
    : undefined;

  const anyAvailable = cards?.some((c) => c.available) ?? false;
  const topLessonKey = q.data ? pickTopLesson(q.data) : null;
  const topLessonCard = topLessonKey && q.data ? CARD_BUILDERS[topLessonKey](q.data) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Coach</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your own patterns, named from your real trades — computed, not AI-generated.</p>
      </div>

      {levelQ.isLoading ? (
        <Card>
          <CardContent className="p-0">
            <LoadingState label="Reading your activity…" />
          </CardContent>
        </Card>
      ) : levelQ.isError ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState message={(levelQ.error as Error)?.message} />
          </CardContent>
        </Card>
      ) : levelQ.data ? (
        <ExperienceLevelCard result={levelQ.data} />
      ) : null}

      {q.isLoading ? (
        <Card>
          <CardContent className="p-0">
            <LoadingState label="Reading your trade history…" />
          </CardContent>
        </Card>
      ) : q.isError ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState message={(q.error as Error)?.message} />
          </CardContent>
        </Card>
      ) : !anyAvailable ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Compass}
              title="Not enough trade history yet"
              description="Every pattern here needs a minimum number of closed trades before it means anything — a single lucky or unlucky trade shouldn't define a 'pattern.' Keep trading (and closing positions), and this page will start filling in on its own."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {topLessonCard ? (
            <Card className="border-[color:var(--color-primary)]/40">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[color:var(--color-primary)]" />
                  <CardTitle className="text-base">Right now, this is worth your attention</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium text-foreground">{topLessonCard.title}</p>
                <p className="text-sm text-foreground">{topLessonCard.headline}</p>
                {topLessonCard.detail && <p className="text-xs text-muted-foreground">{topLessonCard.detail}</p>}
                <p className="border-t border-border pt-3 text-xs text-muted-foreground">{topLessonCard.whyItMatters}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[color:var(--color-gain)]" />
              Nothing stands out right now — no single pattern is flagged in your recent activity.
            </div>
          )}

          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Full breakdown</p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {cards!.map((c) => (
                <PatternCardView key={c.title} card={c} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const LEVEL_META: Record<ExperienceLevel, { label: string; description: string }> = {
  new: { label: "New", description: "Just getting started — every trade, symbol, and journal entry counts toward the next level." },
  developing: { label: "Developing", description: "You're building real habits across trading, journalling, and diversification." },
  experienced: { label: "Experienced", description: "You've shown broad, consistent activity across every dimension we track." },
};

/** Derived ONLY from observable behaviour (trades, instruments, journalling,
 *  diversification) — never from returns or P&L. See lib/coaching/level.ts. */
function ExperienceLevelCard({ result }: { result: ExperienceLevelResult }) {
  const meta = LEVEL_META[result.level];
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Experience level</CardTitle>
          </div>
          <Badge variant="secondary">{meta.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{meta.description}</p>

        <div className="space-y-3">
          {result.criteria.map((c) => {
            const bar = result.level === "experienced" ? c.experiencedBar : result.level === "developing" ? c.experiencedBar : c.developingBar;
            const pct = Math.min(100, Math.round((c.value / bar) * 100));
            return (
              <div key={c.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{c.label}</span>
                  <span className="tabular font-medium text-foreground">
                    {c.value} / {bar}
                  </span>
                </div>
                <Progress value={pct} className="h-1.5" />
              </div>
            );
          })}
        </div>

        {result.nextLevelNeeds.length > 0 && (
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            To advance: {result.nextLevelNeeds.map((n) => `${n.label} (${n.current} of ${n.target})`).join(", ")}.
          </p>
        )}

        <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
          Based only on what you've done — never on whether you're up or down. A diligent trader who's losing money ranks the same as an equally diligent one who's winning.
        </p>
      </CardContent>
    </Card>
  );
}

function PatternCardView({ card }: { card: PatternCard }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{card.title}</CardTitle>
          {card.available && (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">n={card.n}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={card.available ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>{card.headline}</p>
        {card.detail && <p className="text-xs text-muted-foreground">{card.detail}</p>}
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">{card.whyItMatters}</p>
      </CardContent>
    </Card>
  );
}
