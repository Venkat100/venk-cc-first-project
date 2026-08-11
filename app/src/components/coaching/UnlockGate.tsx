// PLAN.md §6 step 8 (B3) — progressive unlocks for options/margin.
//
// TONE, per the kickoff: invitational, never condescending. A locked feature
// reads as "here's a 2-minute primer, then it's yours" — never "you're not
// ready." A user who reads the primer and answers 3 quick questions gets
// access, full stop; getting one wrong just re-teaches that point and lets
// them retry immediately, same question, no waiting, no penalty.
//
// Grading is LOCAL/INSTANT per question (comparing the selection directly
// against quiz.ts's correctIndex — already visible in the client bundle by
// design, see quiz.ts's header) so retrying feels immediate. The final
// unlock is only ever recorded once submitQuizAnswers() round-trips through
// unlockFeatureFn, which re-validates every answer server-side before
// calling unlock_feature() — the client's local grading is a UX nicety, not
// the authority.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/DataStates";
import { Lock, CheckCircle2, XCircle, PartyPopper } from "lucide-react";
import { getUnlockStatuses, submitQuizAnswers } from "@/lib/coaching/api";
import { quizFor, type Feature } from "@/lib/coaching/quiz";

const SHEET_CONTENT_CLASS =
  "inset-x-0 bottom-0 left-0 top-auto max-h-[85vh] w-full max-w-full translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-t-2xl rounded-b-none border-t p-0 sm:inset-auto sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:max-h-[90vh] sm:w-full sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border";

const PRIMER: Record<Feature, { title: string; intro: string; points: string[] }> = {
  options: {
    title: "Options are powerful and easy to misuse",
    intro: "A 2-minute primer, then they're yours — no strings attached.",
    points: [
      "One contract controls 100 shares. A small move in the stock can mean a big move in the contract's value.",
      "If the stock doesn't move your way by expiration, the contract can expire worthless — a total loss of what you paid.",
      "Premiums here are estimated with a pricing model from live prices, not live exchange quotes.",
    ],
  },
  margin: {
    title: "Margin is powerful and easy to misuse",
    intro: "A 2-minute primer, then it's yours — no strings attached.",
    points: [
      "Borrowing to invest amplifies your gains — and your losses, the same way.",
      "If your equity falls too far relative to your loan, it's a margin call: positions get sold automatically to bring your account back into line.",
      "Interest accrues daily on any outstanding balance, whether you trade or not.",
    ],
  },
};

const FEATURE_LABEL: Record<Feature, string> = { options: "Options", margin: "Margin" };

type Stage = "primer" | "quiz" | "unlocked";

function QuizQuestionStep({ feature, onAllPassedLocally }: { feature: Feature; onAllPassedLocally: (answers: number[]) => void }) {
  const quiz = quizFor(feature);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<number[]>(() => Array(quiz.length).fill(-1));
  const [selected, setSelected] = useState<string>("");
  const [graded, setGraded] = useState<"correct" | "wrong" | null>(null);

  const q = quiz[index];

  function handleCheck() {
    if (selected === "") return;
    const choice = Number(selected);
    if (choice === q.correctIndex) {
      setGraded("correct");
    } else {
      setGraded("wrong");
    }
  }

  function handleContinue() {
    const next = [...answers];
    next[index] = q.correctIndex; // by construction: "Continue" only appears once graded === "correct"
    setAnswers(next);
    setGraded(null);
    setSelected("");
    if (index < quiz.length - 1) {
      setIndex(index + 1);
    } else {
      onAllPassedLocally(next);
    }
  }

  function handleRetry() {
    setGraded(null);
    setSelected("");
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-medium text-muted-foreground">
        Question {index + 1} of {quiz.length}
      </p>
      <p className="text-sm font-medium text-foreground">{q.prompt}</p>

      {graded !== "wrong" ? (
        <RadioGroup value={selected} onValueChange={setSelected} className="gap-2.5">
          {q.choices.map((choice, i) => (
            <Label
              key={i}
              htmlFor={`${q.id}-${i}`}
              className="flex cursor-pointer items-center gap-2.5 rounded-md border border-border px-3 py-2.5 text-sm font-normal text-foreground hover:bg-surface"
            >
              <RadioGroupItem id={`${q.id}-${i}`} value={String(i)} disabled={graded === "correct"} />
              {choice}
            </Label>
          ))}
        </RadioGroup>
      ) : (
        <div className="space-y-3 rounded-md border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-3 py-3">
          <div className="flex items-start gap-2 text-sm text-foreground">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning,#d97706)]" />
            <p>{q.reteach}</p>
          </div>
        </div>
      )}

      {graded === "correct" && (
        <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-500">
          <CheckCircle2 className="h-4 w-4" /> Correct.
        </div>
      )}

      <div className="flex justify-end gap-2">
        {graded === "wrong" && (
          <Button onClick={handleRetry} variant="outline">
            Try again
          </Button>
        )}
        {graded === null && (
          <Button onClick={handleCheck} disabled={selected === ""}>
            Check answer
          </Button>
        )}
        {graded === "correct" && (
          <Button onClick={handleContinue}>{index < quiz.length - 1 ? "Next question" : "Finish"}</Button>
        )}
      </div>
    </div>
  );
}

function UnlockDialog({ feature, open, onOpenChange, onUnlocked }: { feature: Feature; open: boolean; onOpenChange: (open: boolean) => void; onUnlocked: () => void }) {
  const [stage, setStage] = useState<Stage>("primer");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const primer = PRIMER[feature];

  async function handleAllPassedLocally(answers: number[]) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await submitQuizAnswers(feature, answers);
      if (res.passed) {
        setStage("unlocked");
        onUnlocked();
      } else {
        // Server disagreed with local grading (quiz bank drift, stale
        // client) — extremely unlikely, but fall back to re-teaching from
        // question 1 rather than silently failing.
        setSubmitError("One of your answers didn't check out on our end — let's go through it again.");
        setStage("quiz");
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose(next: boolean) {
    if (!next) setStage("primer"); // reset for next open
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={SHEET_CONTENT_CLASS}>
        <DialogHeader className="border-b border-border px-4 py-3 text-left sm:px-5">
          <DialogTitle className="text-base">
            {stage === "unlocked" ? `${FEATURE_LABEL[feature]} unlocked` : `Unlock ${FEATURE_LABEL[feature]}`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-4 py-4 sm:px-5">
          {stage === "primer" && (
            <>
              <p className="text-sm font-medium text-foreground">{primer.title}</p>
              <ul className="space-y-2.5 text-sm text-muted-foreground">
                {primer.points.map((p, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{primer.intro}</p>
              <div className="flex justify-end">
                <Button onClick={() => setStage("quiz")}>Start the quick check</Button>
              </div>
            </>
          )}

          {stage === "quiz" && (
            <>
              {submitError && <p className="text-sm text-destructive">{submitError}</p>}
              {submitting ? <LoadingState label="Checking your answers…" /> : <QuizQuestionStep feature={feature} onAllPassedLocally={handleAllPassedLocally} />}
            </>
          )}

          {stage === "unlocked" && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <PartyPopper className="h-8 w-8 text-primary" />
              <p className="text-sm font-medium text-foreground">You're all set — {FEATURE_LABEL[feature]} is unlocked.</p>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Renders `children` once `feature` is unlocked (via a passed quiz OR
 *  grandfathered prior activity — see lib/coaching/unlocks.ts). Otherwise
 *  renders an inviting locked card that opens the primer+quiz dialog. */
export function UnlockGate({ feature, children }: { feature: Feature; children: React.ReactNode }) {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const statusQ = useQuery({ queryKey: ["coachingUnlockStatuses"], queryFn: getUnlockStatuses, staleTime: 30_000 });

  if (statusQ.isLoading) {
    return (
      <div className="py-10">
        <LoadingState label="Checking access…" />
      </div>
    );
  }

  const unlocked = statusQ.data?.[feature]?.unlocked ?? false;
  if (unlocked) return <>{children}</>;

  const primer = PRIMER[feature];
  return (
    <>
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-semibold text-foreground">{primer.title}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{primer.intro}</p>
          <Button onClick={() => setDialogOpen(true)} className="mt-1">
            Start the 2-minute primer
          </Button>
        </CardContent>
      </Card>
      <UnlockDialog
        feature={feature}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onUnlocked={() => qc.invalidateQueries({ queryKey: ["coachingUnlockStatuses"] })}
      />
    </>
  );
}
