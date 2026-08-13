// AUDIT.md Part 6(c) item 10 (2026-08-14 Tier-2 fix pass) — the proactive
// Coach nudge. Gated on the EXACT same computation the Coach page's own
// "Right now, this is worth your attention" card uses (pickTopLesson over
// computeBehavioralAnalytics's real per-pattern statistical thresholds) —
// deliberately NOT a separate trade-count rule, so it is structurally
// impossible to nudge a user toward a page that says "not enough trades
// yet": pickTopLesson only ever returns non-null when a pattern has BOTH
// cleared its own sample-size minimum AND shown its concerning/positive
// signature (lib/coaching/priority.ts).
//
// Dismissal is keyed by (lesson_key, n) — see 0028's migration comment for
// why re-showing only when n changes is the right "genuinely new
// observation" boundary, not a fresh dismissal on every render.
//
// Discreet card, not a modal/toast — an invitation, not an interruption
// (kickoff's own tone rule, same standard as the Coach page itself).
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Compass, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { getBehavioralAnalytics } from "@/lib/behavioral/api";
import { getNudgeDismissals, dismissNudge } from "@/lib/coaching/queries";
import { pickTopLesson } from "@/lib/coaching/priority";
import { CARD_BUILDERS } from "@/lib/behavioral/copy";
import { trackClientEvent, useTrackOnce } from "@/lib/analytics/api";

export function CoachNudgeCard() {
  const qc = useQueryClient();
  const analyticsQ = useQuery({ queryKey: ["behavioralAnalytics"], queryFn: getBehavioralAnalytics });
  const dismissalsQ = useQuery({ queryKey: ["coachNudgeDismissals"], queryFn: getNudgeDismissals });

  if (analyticsQ.isLoading || dismissalsQ.isLoading || analyticsQ.isError || dismissalsQ.isError) return null;

  const topLessonKey = analyticsQ.data ? pickTopLesson(analyticsQ.data) : null;
  if (!topLessonKey || !analyticsQ.data) return null;

  const card = CARD_BUILDERS[topLessonKey](analyticsQ.data);
  const n = analyticsQ.data[topLessonKey].n;
  const dismissedAtN = dismissalsQ.data?.get(topLessonKey);
  if (dismissedAtN === n) return null; // same finding already dismissed — don't re-nag

  return (
    // key forces a fresh mount (and thus a fresh "shown" fire) whenever the
    // finding itself changes — a different pattern, or the same pattern at
    // a new n after more trades.
    <NudgeCardBody key={`${topLessonKey}-${n}`} lessonKey={topLessonKey} n={n} card={card} onDismissed={() => qc.invalidateQueries({ queryKey: ["coachNudgeDismissals"] })} />
  );
}

function NudgeCardBody({
  lessonKey,
  n,
  card,
  onDismissed,
}: {
  lessonKey: string;
  n: number;
  card: { title: string; headline: string };
  onDismissed: () => void;
}) {
  useTrackOnce("coach_nudge_shown", { lessonKey, n }, [lessonKey, n]);

  return (
    <Card className="border-[color:var(--color-primary)]/30 bg-primary/[0.03]">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/15 text-[color:var(--color-primary)]">
          <Compass className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{card.title}</p>
          <p className="text-sm text-foreground">{card.headline}</p>
          <Link
            to="/app/coach"
            className="inline-block text-xs font-medium text-[color:var(--color-primary)] hover:underline"
            onClick={() => trackClientEvent("coach_nudge_clicked", { lessonKey, n })}
          >
            See the full picture in Coach →
          </Link>
        </div>
        <button
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={async () => {
            trackClientEvent("coach_nudge_dismissed", { lessonKey, n });
            await dismissNudge(lessonKey, n);
            onDismissed();
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </CardContent>
    </Card>
  );
}
