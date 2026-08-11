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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { getBehavioralAnalytics } from "@/lib/behavioral/api";
import {
  dispositionCard,
  overTradingCard,
  concentrationCard,
  revengeTradingCard,
  winRateCard,
  journalCorrelationCard,
  type Card as PatternCard,
} from "@/lib/behavioral/copy";
import { Compass } from "lucide-react";

export const Route = createFileRoute("/app/coach")({
  head: () => ({ meta: [{ title: "Coach · PaperTrader" }] }),
  component: Coach,
});

function Coach() {
  const q = useQuery({ queryKey: ["behavioralAnalytics"], queryFn: getBehavioralAnalytics });

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Coach</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your own patterns, named from your real trades — computed, not AI-generated.</p>
      </div>

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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {cards!.map((c) => (
            <PatternCardView key={c.title} card={c} />
          ))}
        </div>
      )}
    </div>
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
