// Client entry points for adaptive coaching (B3). Same pattern as
// lib/margin/api.ts: plain RLS-scoped reads via queries.ts for status/level,
// token-attached server-function call only for the one write path
// (unlockFeatureFn — quiz submission).

import { supabase } from "@/lib/supabase/client";
import { getRawUnlockInputs, getExperienceInputs } from "./queries";
import { computeUnlockStatus, type UnlockStatus } from "./unlocks";
import { computeExperienceLevel, type ExperienceLevelResult } from "./level";
import { unlockFeatureFn } from "./functions";
import type { Feature } from "./quiz";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

export type UnlockStatuses = { options: UnlockStatus; margin: UnlockStatus };

/** Both features' unlock status in one round trip. Grandfathering is folded
 *  in here, transparently — a caller never needs to know whether "unlocked"
 *  came from a passed quiz or prior real activity. */
export async function getUnlockStatuses(): Promise<UnlockStatuses> {
  const raw = await getRawUnlockInputs();
  return {
    options: computeUnlockStatus(raw.optionsUnlockedAt, raw.hasOptionActivity),
    margin: computeUnlockStatus(raw.marginUnlockedAt, raw.hasEverEnabledMargin),
  };
}

/** Explainable experience level — see lib/coaching/level.ts for the fixed,
 *  transparent criteria this is built from. */
export async function getExperienceLevel(): Promise<ExperienceLevelResult> {
  const inputs = await getExperienceInputs();
  return computeExperienceLevel(inputs);
}

export type QuizSubmissionResult = { passed: true; unlockedAt: string } | { passed: false; results: boolean[] };

/** Submit quiz answers for a feature. A wrong answer is a NORMAL result, not
 *  a thrown error — the caller re-teaches the missed question(s) and lets
 *  the user retry immediately (see UnlockGate.tsx). Only a genuine failure
 *  (network, auth) throws. */
export async function submitQuizAnswers(feature: Feature, answers: number[]): Promise<QuizSubmissionResult> {
  const res = await unlockFeatureFn({ data: { accessToken: await token(), feature, answers } });
  if (!res.ok) throw new Error(res.error);
  return res.passed ? { passed: true, unlockedAt: res.unlockedAt } : { passed: false, results: res.results };
}
