// Throwaway unit test for the ADAPTIVE COACHING pure modules (vite-node —
// no network, no DB). Same convention as verify-behavioral-analytics.ts:
// every input is synthetic and constructed so the answer is known BY
// CONSTRUCTION. Covers quiz.ts, unlocks.ts, priority.ts, level.ts.

import { OPTIONS_QUIZ, MARGIN_QUIZ, checkAnswers } from "@/lib/coaching/quiz";
import { computeUnlockStatus } from "@/lib/coaching/unlocks";
import { pickTopLesson } from "@/lib/coaching/priority";
import { computeExperienceLevel } from "@/lib/coaching/level";
import type { BehavioralAnalytics } from "@/lib/behavioral/metrics";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

console.log("\n████ 1. quiz.ts — question banks + checkAnswers ████");
{
  assert("options quiz has 3 questions", OPTIONS_QUIZ.length === 3, `got ${OPTIONS_QUIZ.length}`);
  assert("margin quiz has 3 questions", MARGIN_QUIZ.length === 3, `got ${MARGIN_QUIZ.length}`);
  assert("every options question has a reteach string", OPTIONS_QUIZ.every((q) => q.reteach.length > 0));
  assert("every margin question has a reteach string", MARGIN_QUIZ.every((q) => q.reteach.length > 0));
  assert("every correctIndex is a valid choice index", [...OPTIONS_QUIZ, ...MARGIN_QUIZ].every((q) => q.correctIndex >= 0 && q.correctIndex < q.choices.length));

  const allCorrectOptions = OPTIONS_QUIZ.map((q) => q.correctIndex);
  const r1 = checkAnswers("options", allCorrectOptions);
  assert("options: all-correct answers -> allCorrect true", r1.allCorrect === true);
  assert("options: results are all true", r1.results.every(Boolean));

  const oneWrong = [...allCorrectOptions];
  oneWrong[0] = (oneWrong[0] + 1) % OPTIONS_QUIZ[0].choices.length;
  const r2 = checkAnswers("options", oneWrong);
  assert("options: one wrong answer -> allCorrect false", r2.allCorrect === false);
  assert("options: results[0] false, rest true", r2.results[0] === false && r2.results.slice(1).every(Boolean));

  const r3 = checkAnswers("margin", []);
  assert("margin: empty submission -> allCorrect false (never vacuously true)", r3.allCorrect === false);

  const r4 = checkAnswers("margin", MARGIN_QUIZ.map((q) => q.correctIndex));
  assert("margin: all-correct answers -> allCorrect true", r4.allCorrect === true);

  // Retry semantics: a fresh checkAnswers call after "fixing" the wrong
  // answer succeeds — proves there's no hidden state penalizing a retry.
  const fixed = [...oneWrong];
  fixed[0] = allCorrectOptions[0];
  const r5 = checkAnswers("options", fixed);
  assert("options: retry after fixing the wrong answer -> allCorrect true (no penalty state)", r5.allCorrect === true);
}

console.log("\n████ 2. unlocks.ts — computeUnlockStatus ████");
{
  const locked = computeUnlockStatus(null, false);
  assert("locked: unlocked=false, reason=locked", locked.unlocked === false && locked.reason === "locked");
  assert("locked: unlockedAt is null", locked.unlockedAt === null);

  const quizUnlocked = computeUnlockStatus("2026-08-01T00:00:00.000Z", false);
  assert("quiz-unlocked: unlocked=true, reason=quiz", quizUnlocked.unlocked === true && quizUnlocked.reason === "quiz");
  assert("quiz-unlocked: unlockedAt echoes the DB timestamp exactly", quizUnlocked.unlockedAt === "2026-08-01T00:00:00.000Z");

  const grandfathered = computeUnlockStatus(null, true);
  assert("grandfathered: unlocked=true, reason=grandfathered", grandfathered.unlocked === true && grandfathered.reason === "grandfathered");
  assert("grandfathered: unlockedAt is null (no discrete unlock moment)", grandfathered.unlockedAt === null);

  // A user who is BOTH grandfathered AND has a recorded unlock timestamp
  // (e.g. unlocked via quiz before we'd have detected prior activity) —
  // the recorded timestamp wins, since it's the more precise fact.
  const both = computeUnlockStatus("2026-08-01T00:00:00.000Z", true);
  assert("both signals present: reason=quiz (recorded timestamp takes precedence)", both.reason === "quiz");
}

console.log("\n████ 3. priority.ts — pickTopLesson ████");
{
  const AVAILABLE_NONE = { available: false as const, n: 0, minRequired: 999, reason: "n/a" };
  function baseAnalytics(): BehavioralAnalytics {
    return {
      disposition: AVAILABLE_NONE,
      overTrading: AVAILABLE_NONE,
      concentration: AVAILABLE_NONE,
      revengeTrading: AVAILABLE_NONE,
      winRate: AVAILABLE_NONE,
      journalCorrelation: AVAILABLE_NONE,
    };
  }

  const allUnavailable = baseAnalytics();
  assert("all metrics unavailable -> no lesson (never surfaces from an unreliable sample)", pickTopLesson(allUnavailable) === null);

  const availableButHealthy: BehavioralAnalytics = {
    ...baseAnalytics(),
    disposition: { available: true, n: 10, data: { winnersN: 5, losersN: 5, avgHoldDaysWinners: 20, avgHoldDaysLosers: 2, avgReturnPctWinners: 0.1, avgReturnPctLosers: -0.1, soldWinnersFaster: false } },
    winRate: { available: true, n: 10, data: { winRate: 0.5, avgReturnPct: 0.05, stdevReturnPct: 0.02, riskAdjustedReturn: 2.5, warningHighWinRateWeakRiskAdjusted: false } },
  };
  assert("available but no triggered signature -> no lesson (silence is the common healthy case)", pickTopLesson(availableButHealthy) === null);

  const dispositionTriggered: BehavioralAnalytics = {
    ...baseAnalytics(),
    disposition: { available: true, n: 10, data: { winnersN: 5, losersN: 5, avgHoldDaysWinners: 2, avgHoldDaysLosers: 20, avgReturnPctWinners: 0.1, avgReturnPctLosers: -0.1, soldWinnersFaster: true } },
  };
  assert("disposition triggered alone -> picked", pickTopLesson(dispositionTriggered) === "disposition");

  const dispositionAndRevenge: BehavioralAnalytics = {
    ...dispositionTriggered,
    revengeTrading: { available: true, n: 10, data: { lossesConsidered: 6, postLossTradesN: 12, avgPostLossTradeSizeUSD: 500, baselineAvgTradeSizeUSD: 200, ratio: 2.5, sizedUpAfterLoss: true } },
  };
  assert("disposition + revenge both triggered -> disposition wins (higher priority)", pickTopLesson(dispositionAndRevenge) === "disposition");

  const revengeOnly: BehavioralAnalytics = {
    ...baseAnalytics(),
    revengeTrading: dispositionAndRevenge.revengeTrading,
  };
  assert("revenge triggered alone -> picked", pickTopLesson(revengeOnly) === "revengeTrading");

  const journalPositiveOnly: BehavioralAnalytics = {
    ...baseAnalytics(),
    journalCorrelation: { available: true, n: 10, data: { notedN: 5, unnotedN: 5, avgReturnPctNoted: 0.15, avgReturnPctUnnoted: 0.02, notedPerformedBetter: true } },
  };
  assert("journal correlation positive signal alone -> picked (lowest priority, but nothing outranks it here)", pickTopLesson(journalPositiveOnly) === "journalCorrelation");

  const journalNegativeOnly: BehavioralAnalytics = {
    ...baseAnalytics(),
    journalCorrelation: { available: true, n: 10, data: { notedN: 5, unnotedN: 5, avgReturnPctNoted: 0.02, avgReturnPctUnnoted: 0.15, notedPerformedBetter: false } },
  };
  assert("journal correlation with noted trades performing WORSE -> no lesson (not framed as a warning)", pickTopLesson(journalNegativeOnly) === null);

  const concentrationBorderline: BehavioralAnalytics = {
    ...baseAnalytics(),
    concentration: { available: true, n: 10, data: { currentLargestSymbol: "AAA", currentLargestSharePct: 0.6, historyAvailable: true, pctOfTimeOverThreshold: 0.5, samplesN: 10 } },
  };
  assert("concentration exactly AT the 50% time-over-threshold bar -> NOT triggered (strictly greater required)", pickTopLesson(concentrationBorderline) === null);

  const concentrationOver: BehavioralAnalytics = {
    ...baseAnalytics(),
    concentration: { available: true, n: 10, data: { currentLargestSymbol: "AAA", currentLargestSharePct: 0.6, historyAvailable: true, pctOfTimeOverThreshold: 0.51, samplesN: 10 } },
  };
  assert("concentration just OVER the 50% bar -> triggered", pickTopLesson(concentrationOver) === "concentration");
}

console.log("\n████ 4. level.ts — computeExperienceLevel ████");
{
  const brandNew = computeExperienceLevel({ tradesPlaced: 0, distinctInstrumentsUsed: 0, journalEntryCount: 0, currentDistinctHoldings: 0 });
  assert("zero activity -> new", brandNew.level === "new");
  assert("zero activity -> nextLevelNeeds lists all 4 developing-bar criteria", brandNew.nextLevelNeeds.length === 4);

  const developing = computeExperienceLevel({ tradesPlaced: 12, distinctInstrumentsUsed: 4, journalEntryCount: 5, currentDistinctHoldings: 0 });
  assert("3 of 4 developing bars cleared (holdings=0 not cleared) -> developing", developing.level === "developing");
  assert("developing: nextLevelNeeds points at the experienced bar, not developing", developing.nextLevelNeeds.every((n) => n.target === 30 || n.target === 6 || n.target === 10 || n.target === 4));

  const experienced = computeExperienceLevel({ tradesPlaced: 40, distinctInstrumentsUsed: 8, journalEntryCount: 12, currentDistinctHoldings: 5 });
  assert("all 4 experienced bars cleared -> experienced", experienced.level === "experienced");
  assert("experienced: nextLevelNeeds is empty (nothing further to show)", experienced.nextLevelNeeds.length === 0);

  // NON-CORRELATION WITH RETURNS: computeExperienceLevel takes NO price/P&L
  // input at all — it is structurally impossible for two accounts with
  // identical observable behaviour but opposite trading outcomes to differ.
  // This is the load-bearing property the live verification must reprove
  // end-to-end (seeded losing-diligent vs lucky-careless accounts), but the
  // pure signature itself already proves it can't happen: there is no return
  // or balance field anywhere in ExperienceInputs.
  const diligentLoser = computeExperienceLevel({ tradesPlaced: 40, distinctInstrumentsUsed: 8, journalEntryCount: 12, currentDistinctHoldings: 5 });
  const carelessWinner = computeExperienceLevel({ tradesPlaced: 40, distinctInstrumentsUsed: 8, journalEntryCount: 12, currentDistinctHoldings: 5 });
  assert("identical observable behaviour -> identical level, regardless of any hypothetical P&L difference", diligentLoser.level === carelessWinner.level);

  // Only 2 of 4 bars cleared -> stays at "new" (need at least 3 of 4).
  const twoOfFour = computeExperienceLevel({ tradesPlaced: 15, distinctInstrumentsUsed: 5, journalEntryCount: 0, currentDistinctHoldings: 0 });
  assert("only 2 of 4 developing bars cleared -> stays new (need >= 3 of 4)", twoOfFour.level === "new");

  // criteria breakdown is fully transparent — every field present and correct.
  const c = developing.criteria.find((c) => c.key === "tradesPlaced")!;
  assert("criteria breakdown: tradesPlaced value/bars/flags all correct and visible", c.value === 12 && c.developingBar === 10 && c.experiencedBar === 30 && c.metDeveloping === true && c.metExperienced === false);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
