// PLAN.md §6 step 8 (B3) — the comprehension check behind options/margin.
// Pure and ISOMORPHIC: imported both by the client (to render questions and
// give immediate feedback) and by the server function (to re-validate a
// submission — see functions.ts). This is a deliberate, documented choice:
// the correct-answer indices are visible in the client bundle, and that's
// fine — this is an educational gate on a paper-trading simulator, not a
// security boundary (see 0024_progressive_unlocks.sql's own header comment).
// What server-side validation actually guards against is a network-level
// tamper: a scripted client calling unlockFeatureFn directly with a
// fabricated "all correct" payload, never having loaded the questions at
// all. That path is closed because the server re-checks every answer
// against this exact bank before ever calling unlock_feature().
//
// Each question deliberately targets the concept that actually hurts
// people (per the kickoff): the 100x multiplier, options expiring
// worthless, leverage amplifying losses, and what a margin call does — plus
// two product-specific reinforcements (premiums aren't live quotes; margin
// interest accrues daily regardless of activity).

export type Feature = "options" | "margin";

export type QuizQuestion = {
  id: string;
  prompt: string;
  choices: string[];
  correctIndex: number;
  /** Shown immediately after a WRONG answer — re-teaches the concept, then
   *  the same question can be retried right away. Never a penalty, never a
   *  lockout — see UnlockGate.tsx. */
  reteach: string;
};

export const OPTIONS_QUIZ: QuizQuestion[] = [
  {
    id: "opt-multiplier",
    prompt: "One options contract in this app typically represents how many shares of the underlying stock?",
    choices: ["1", "10", "100", "1,000"],
    correctIndex: 2,
    reteach: "Each options contract controls 100 shares — that's why a small move in the underlying's price can mean a big swing in the contract's total value.",
  },
  {
    id: "opt-worthless",
    prompt: "You buy a call option. At expiration, the stock is trading BELOW the strike price. What happens to the premium you paid?",
    choices: ["You get it back in full", "It expires worthless — you lose the full premium", "You're paid the difference", "The contract automatically extends"],
    correctIndex: 1,
    reteach: "If a call's strike is above the stock's price at expiration, there's no reason to exercise it — the contract expires worthless, and the premium you paid is a total loss.",
  },
  {
    id: "opt-live-quotes",
    prompt: "Are the options premiums shown in this app the same real-time quotes you'd see from a real options exchange?",
    choices: ["Yes, they're live exchange quotes", "No — they're estimated with a pricing model, not live market quotes"],
    correctIndex: 1,
    reteach: "Real-time options data is a premium product we don't license. Premiums here are calculated from the live stock price and estimated volatility (Black-Scholes) — the mechanics you're learning are real, but the exact number would differ from a live broker's.",
  },
];

export const MARGIN_QUIZ: QuizQuestion[] = [
  {
    id: "mgn-amplify",
    prompt: "You use margin to buy more stock than your cash alone would cover. If the stock drops 10%, are your losses (relative to your OWN cash) bigger, smaller, or the same as without margin?",
    choices: ["Bigger — margin amplifies losses the same way it amplifies gains", "Smaller", "The same"],
    correctIndex: 0,
    reteach: "Margin lets you control more stock with the same cash, which means gains AND losses are both bigger, in dollar terms, relative to your own money on the line.",
  },
  {
    id: "mgn-call",
    prompt: "What is a margin call?",
    choices: ["A phone call from your broker checking in", "A forced sale of your positions because your account equity fell below the required level", "A bonus for using margin responsibly", "An optional check-in you can ignore"],
    correctIndex: 1,
    reteach: "If your equity falls too far relative to your loan, positions get sold automatically — often at the worst possible moment — to bring your account back into compliance. It isn't a warning you can opt out of once triggered.",
  },
  {
    id: "mgn-interest",
    prompt: "Does interest on a margin loan accrue even on days you don't place a single trade?",
    choices: ["Yes — it accrues daily on any outstanding balance, whether you trade or not", "No — only on days you trade"],
    correctIndex: 0,
    reteach: "Margin interest accrues daily on whatever loan balance is outstanding, independent of trading activity — an unused loan still costs you every day it's open.",
  },
];

export function quizFor(feature: Feature): QuizQuestion[] {
  return feature === "options" ? OPTIONS_QUIZ : MARGIN_QUIZ;
}

/** Pure validation: every question must be answered, in order, all correct.
 *  Used identically by the server (authoritative) and optionally by the
 *  client (instant local feedback before even calling the server). */
export function checkAnswers(feature: Feature, answers: number[]): { allCorrect: boolean; results: boolean[] } {
  const quiz = quizFor(feature);
  const results = quiz.map((q, i) => answers[i] === q.correctIndex);
  return { allCorrect: results.length === quiz.length && results.every(Boolean), results };
}
