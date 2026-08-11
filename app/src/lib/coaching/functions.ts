// PLAN.md §6 step 8 (B3) — the ONE write path for progressive unlocks.
// Same shape as lib/margin/functions.ts: JWT-verified identity, service-role
// execution. checkAnswers() is re-run HERE, server-side, against the exact
// same canonical quiz.ts bank the client rendered — a scripted client
// calling this function directly with a fabricated "all correct" payload
// still has to submit indices that actually match every correct answer.
// (Educational gate, not a security boundary — see 0024_progressive_unlocks.sql.)

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { checkAnswers, quizFor, type Feature } from "./quiz";

function friendly(token: string): string {
  if (token.includes("profile_not_found")) return "We couldn't find your account.";
  if (token.includes("invalid_feature")) return "That's not a recognized feature.";
  if (token.includes("not_signed_in")) return "Your session has expired — please sign in again.";
  return "Sorry — that couldn't be completed. Please try again.";
}

export type UnlockFeatureResponse =
  | { ok: true; passed: true; unlockedAt: string }
  | { ok: true; passed: false; results: boolean[] } // wrong answer(s) — re-teach, let them retry immediately
  | { ok: false; error: string };

export const unlockFeatureFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      feature: z.enum(["options", "margin"]),
      answers: z.array(z.number().int().nonnegative()),
    }),
  )
  .handler(async ({ data }): Promise<UnlockFeatureResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const feature = data.feature as Feature;

      const { allCorrect, results } = checkAnswers(feature, data.answers);
      if (data.answers.length !== quizFor(feature).length || !allCorrect) {
        return { ok: true, passed: false, results };
      }

      const admin = getServiceClient();
      const { data: rpc, error } = await admin.rpc("unlock_feature", { p_user_id: userId, p_feature: feature });
      if (error) return { ok: false, error: friendly(error.message) };
      return { ok: true, passed: true, unlockedAt: String(rpc) };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
