// Real E2E for PLAN.md §6 step 8 (B3 — progressive unlocks + adaptive
// coaching), vite-node. Real Supabase (RLS-scoped per-user anon clients +
// service_role admin client), real execute_trade/set_margin_enabled/
// reset_paper_account/unlock_feature RPCs — no mocks.
//
// METHODOLOGY NOTE (same as every other *-live.ts script in this repo):
// unlockFeatureFn is a TanStack Start server function and cannot be invoked
// directly outside the Start runtime ("No Start context found in
// AsyncLocalStorage"). This script exercises the REAL underlying logic
// instead — checkAnswers() + admin.rpc("unlock_feature", ...), the exact
// two calls the handler makes — and separately proves the RLS-scoped read
// queries (lib/coaching/queries.ts) reconcile with the pure compute modules
// by re-implementing those exact same SELECTs against real per-user
// sessions, then feeding the real rows into computeUnlockStatus /
// computeExperienceLevel / pickTopLesson.
//
// Trade prices here are deliberately SYNTHETIC fixed numbers, not live
// quotes — this script is about the coaching layer (unlocks, grandfathering,
// lesson priority, experience level), which is entirely price-scheme
// agnostic; live-price integration is already proven in other *-live.ts
// scripts. execute_trade's RPC layer never validates price against a real
// market feed (that's enforced one layer up, by the server function that
// calls it) — passing fixed numbers directly is the same thing
// verify-margin-live.ts and others already do for non-price-sensitive setup.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser } from "./verify-harness";
import { checkAnswers, quizFor, OPTIONS_QUIZ, MARGIN_QUIZ } from "@/lib/coaching/quiz";
import { computeUnlockStatus } from "@/lib/coaching/unlocks";
import { computeExperienceLevel, type ExperienceInputs } from "@/lib/coaching/level";
import { pickTopLesson } from "@/lib/coaching/priority";
import { computeBehavioralAnalytics } from "@/lib/behavioral/metrics";
import type { Transaction } from "@/lib/supabase/types";

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms))]);
}
async function step<T>(label: string, fn: () => Promise<T>, ms = 20000): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}
let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const admin = getServiceClient();
const anonUrl = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;
const PASSWORD = "CoachingVerifyTest!234";
const created: string[] = [];

async function createUser(label: string, stamp: number): Promise<{ uid: string; email: string }> {
  const email = `pt-coach-${label}-${stamp}@example.org`;
  const { uid } = await step(`create user ${label}`, () => createTestUser(admin, email, PASSWORD));
  created.push(uid);
  return { uid, email };
}

async function signIn(email: string) {
  const client = createClient(anonUrl, anonKey, { auth: { persistSession: false } });
  const res = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (res.error) throw new Error(`sign-in failed for ${email}: ${res.error.message}`);
  return client;
}

async function buy(userId: string, symbol: string, qty: number, price: number) {
  const r = await admin.rpc("execute_trade", { p_user_id: userId, p_symbol: symbol, p_side: "buy", p_quantity: qty, p_price: price });
  if (r.error) throw new Error(`buy ${symbol} failed: ${r.error.message}`);
  return String((r.data as Record<string, unknown>).transaction_id);
}
async function sell(userId: string, symbol: string, qty: number, price: number) {
  const r = await admin.rpc("execute_trade", { p_user_id: userId, p_symbol: symbol, p_side: "sell", p_quantity: qty, p_price: price });
  if (r.error) throw new Error(`sell ${symbol} failed: ${r.error.message}`);
  return String((r.data as Record<string, unknown>).transaction_id);
}

// Exactly the SELECTs lib/coaching/queries.ts's getRawUnlockInputs makes,
// run against a REAL per-user RLS-scoped client — proves the read path, not
// just the pure compute.
async function readRawUnlockInputs(userClient: ReturnType<typeof createClient>, userId: string) {
  const [profileRes, optionActivityRes, marginEventRes] = await Promise.all([
    userClient.from("profiles").select("options_unlocked_at, margin_unlocked_at, margin_enabled").eq("id", userId).single(),
    userClient.from("option_transactions").select("id").eq("user_id", userId).limit(1),
    userClient.from("margin_events").select("id").eq("user_id", userId).eq("kind", "enabled").limit(1),
  ]);
  if (profileRes.error || !profileRes.data) throw profileRes.error ?? new Error("profile read failed");
  if (optionActivityRes.error) throw optionActivityRes.error;
  if (marginEventRes.error) throw marginEventRes.error;
  return {
    optionsUnlockedAt: profileRes.data.options_unlocked_at as string | null,
    marginUnlockedAt: profileRes.data.margin_unlocked_at as string | null,
    hasOptionActivity: (optionActivityRes.data?.length ?? 0) > 0,
    hasEverEnabledMargin: Boolean(profileRes.data.margin_enabled) || (marginEventRes.data?.length ?? 0) > 0,
  };
}

// Exactly the SELECTs lib/coaching/queries.ts's getExperienceInputs makes.
async function readExperienceInputs(userClient: ReturnType<typeof createClient>, userId: string): Promise<ExperienceInputs> {
  const [txRes, optTxRes, journalCountRes, holdingsRes] = await Promise.all([
    userClient.from("transactions").select("symbol").eq("user_id", userId),
    userClient.from("option_transactions").select("symbol").eq("user_id", userId),
    userClient.from("journal_entries").select("id", { count: "exact", head: true }),
    userClient.from("holdings").select("symbol").eq("user_id", userId),
  ]);
  if (txRes.error) throw txRes.error;
  if (optTxRes.error) throw optTxRes.error;
  if (journalCountRes.error) throw journalCountRes.error;
  if (holdingsRes.error) throw holdingsRes.error;
  const symbols = new Set<string>();
  for (const r of (txRes.data ?? []) as { symbol: string }[]) symbols.add(r.symbol);
  for (const r of (optTxRes.data ?? []) as { symbol: string }[]) symbols.add(r.symbol);
  return {
    tradesPlaced: (txRes.data?.length ?? 0) + (optTxRes.data?.length ?? 0),
    distinctInstrumentsUsed: symbols.size,
    journalEntryCount: journalCountRes.count ?? 0,
    currentDistinctHoldings: holdingsRes.data?.length ?? 0,
  };
}

// The exact two calls unlockFeatureFn's handler makes — server-side
// re-validation, then the RPC. Returns the same shape the real handler
// would return.
async function submitQuiz(userId: string, feature: "options" | "margin", answers: number[]) {
  const { allCorrect, results } = checkAnswers(feature, answers);
  if (answers.length !== quizFor(feature).length || !allCorrect) {
    return { passed: false as const, results };
  }
  const rpc = await admin.rpc("unlock_feature", { p_user_id: userId, p_feature: feature });
  if (rpc.error) throw new Error(rpc.error.message);
  return { passed: true as const, unlockedAt: String(rpc.data) };
}

async function main() {
  const stamp = Date.now();

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 1. FRESH ACCOUNT — both features locked, real read path ████");
  // ════════════════════════════════════════════════════════════════════
  const fresh = await createUser("fresh", stamp);
  const freshClient = await step("sign in as fresh", () => signIn(fresh.email));

  const freshRaw = await step("read fresh user's raw unlock inputs (real RLS-scoped session)", () => readRawUnlockInputs(freshClient, fresh.uid));
  assert("fresh: options_unlocked_at is null", freshRaw.optionsUnlockedAt === null);
  assert("fresh: margin_unlocked_at is null", freshRaw.marginUnlockedAt === null);
  assert("fresh: no option activity", freshRaw.hasOptionActivity === false);
  assert("fresh: never enabled margin", freshRaw.hasEverEnabledMargin === false);

  const freshOptionsStatus = computeUnlockStatus(freshRaw.optionsUnlockedAt, freshRaw.hasOptionActivity);
  const freshMarginStatus = computeUnlockStatus(freshRaw.marginUnlockedAt, freshRaw.hasEverEnabledMargin);
  assert("fresh: options LOCKED (not a wall — UnlockGate renders the inviting explainer card for this state)", freshOptionsStatus.unlocked === false && freshOptionsStatus.reason === "locked");
  assert("fresh: margin LOCKED", freshMarginStatus.unlocked === false && freshMarginStatus.reason === "locked");

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 2. WRONG ANSWER — re-teaches that question, does NOT unlock, retry succeeds ████");
  // ════════════════════════════════════════════════════════════════════
  const correctOptionsAnswers = OPTIONS_QUIZ.map((q) => q.correctIndex);
  const oneWrong = [...correctOptionsAnswers];
  oneWrong[1] = (oneWrong[1] + 1) % OPTIONS_QUIZ[1].choices.length; // deliberately wrong on question 2

  const wrongSubmission = await step("submit quiz with one wrong answer", () => submitQuiz(fresh.uid, "options", oneWrong));
  assert("wrong submission: passed = false", wrongSubmission.passed === false);
  if (!wrongSubmission.passed) {
    assert("wrong submission: results[1] is false (the wrong one), others true", wrongSubmission.results[1] === false && wrongSubmission.results[0] === true && wrongSubmission.results[2] === true);
  }
  const afterWrongProfile = await step("re-read profile after wrong submission (admin, ground truth)", () =>
    admin.from("profiles").select("options_unlocked_at").eq("id", fresh.uid).single(),
  );
  assert("wrong submission never called unlock_feature — options_unlocked_at STILL null", afterWrongProfile.data?.options_unlocked_at === null);

  const retrySubmission = await step("retry IMMEDIATELY with corrected answers — no lockout, no waiting", () => submitQuiz(fresh.uid, "options", correctOptionsAnswers));
  assert("retry: passed = true", retrySubmission.passed === true);
  const retryUnlockedAt = retrySubmission.passed ? retrySubmission.unlockedAt : null;
  assert("retry: unlockedAt is a real timestamp", typeof retryUnlockedAt === "string" && retryUnlockedAt.length > 0);

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 3. PERSISTENCE ACROSS A SESSION REFRESH — brand-new client + fresh sign-in ████");
  // ════════════════════════════════════════════════════════════════════
  const freshClient2 = await step("simulate a session refresh: brand-new anon client, sign in again", () => signIn(fresh.email));
  const rawAfterUnlock = await step("re-read raw unlock inputs on the NEW session", () => readRawUnlockInputs(freshClient2, fresh.uid));
  assert("persisted: options_unlocked_at matches the timestamp from step 2 exactly", rawAfterUnlock.optionsUnlockedAt === retryUnlockedAt, `${rawAfterUnlock.optionsUnlockedAt} vs ${retryUnlockedAt}`);
  const persistedStatus = computeUnlockStatus(rawAfterUnlock.optionsUnlockedAt, rawAfterUnlock.hasOptionActivity);
  assert("persisted: options now shows unlocked, reason=quiz", persistedStatus.unlocked === true && persistedStatus.reason === "quiz");
  assert("margin STILL locked for this user — unlocking one feature doesn't unlock the other", computeUnlockStatus(rawAfterUnlock.marginUnlockedAt, rawAfterUnlock.hasEverEnabledMargin).unlocked === false);

  const idempotentRpc = await step("call unlock_feature a 2nd time on an already-unlocked feature", () => admin.rpc("unlock_feature", { p_user_id: fresh.uid, p_feature: "options" }));
  assert("idempotent: 2nd call returns the SAME original timestamp, doesn't reset it", String(idempotentRpc.data) === retryUnlockedAt, `${idempotentRpc.data} vs ${retryUnlockedAt}`);

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 4. GRANDFATHERING — prior activity auto-unlocks, NEVER sees a gate ████");
  // ════════════════════════════════════════════════════════════════════
  const grandOpt = await createUser("grand-opt", stamp);
  await step("seed real prior option activity (direct insert, service_role has INSERT on option_transactions)", () =>
    admin
      .from("option_transactions")
      .insert({ user_id: grandOpt.uid, contract_id: "ZZZ-2027-01-15-C-100", symbol: "ZZZ", side: "buy_to_open", contracts: 1, premium: 2.5, total: 250 })
      .select("id")
      .single(),
  );
  const grandOptClient = await step("sign in as grand-opt", () => signIn(grandOpt.email));
  const grandOptRaw = await step("read grand-opt's raw unlock inputs", () => readRawUnlockInputs(grandOptClient, grandOpt.uid));
  const grandOptStatus = computeUnlockStatus(grandOptRaw.optionsUnlockedAt, grandOptRaw.hasOptionActivity);
  assert("grandfathered (options): unlocked = true", grandOptStatus.unlocked === true);
  assert("grandfathered (options): reason = grandfathered, NOT quiz — never took the quiz", grandOptStatus.reason === "grandfathered");
  assert("grandfathered (options): options_unlocked_at was NEVER written (still null) — access came purely from real activity", grandOptRaw.optionsUnlockedAt === null);

  const grandMgn = await createUser("grand-mgn", stamp);
  await step("enable margin (real RPC — this is what 'having used it' means)", () => admin.rpc("set_margin_enabled", { p_user_id: grandMgn.uid, p_enabled: true }));
  await step("later disable margin (still counts — they demonstrated real use)", () => admin.rpc("set_margin_enabled", { p_user_id: grandMgn.uid, p_enabled: false }));
  const grandMgnClient = await step("sign in as grand-mgn", () => signIn(grandMgn.email));
  const grandMgnRaw = await step("read grand-mgn's raw unlock inputs", () => readRawUnlockInputs(grandMgnClient, grandMgn.uid));
  const grandMgnStatus = computeUnlockStatus(grandMgnRaw.marginUnlockedAt, grandMgnRaw.hasEverEnabledMargin);
  assert("grandfathered (margin): unlocked = true even though margin is OFF right now", grandMgnStatus.unlocked === true);
  assert("grandfathered (margin): reason = grandfathered", grandMgnStatus.reason === "grandfathered");
  assert("grandfathered (margin): margin_unlocked_at was NEVER written", grandMgnRaw.marginUnlockedAt === null);
  assert("grandfathered (margin): options is STILL locked for this user — grandfathering is per-feature, not global", computeUnlockStatus(grandMgnRaw.optionsUnlockedAt, grandMgnRaw.hasOptionActivity).unlocked === false);

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 5. RESET does NOT re-lock an already-unlocked feature ████");
  // ════════════════════════════════════════════════════════════════════
  const resetUser = await createUser("reset", stamp);
  const passResult = await step("pass the margin quiz for reset-user", () => submitQuiz(resetUser.uid, "margin", MARGIN_QUIZ.map((q) => q.correctIndex)));
  if (!passResult.passed) throw new Error("expected margin quiz to pass");
  await step("do a little trading before reset", () => buy(resetUser.uid, "RESETSYM", 5, 50));
  const beforeReset = await step("read profile before reset", () => admin.from("profiles").select("margin_unlocked_at").eq("id", resetUser.uid).single());
  await step("reset_paper_account RPC", () => admin.rpc("reset_paper_account", { p_user_id: resetUser.uid }));
  const afterReset = await step("read profile after reset", () => admin.from("profiles").select("margin_unlocked_at, cash_balance").eq("id", resetUser.uid).single());
  assert("reset: margin_unlocked_at UNCHANGED (exact same timestamp)", afterReset.data?.margin_unlocked_at === beforeReset.data?.margin_unlocked_at, `${afterReset.data?.margin_unlocked_at} vs ${beforeReset.data?.margin_unlocked_at}`);
  assert("reset: cash_balance DID reset (trading state wiped, comprehension didn't)", Number(afterReset.data?.cash_balance) === 25000, `got ${afterReset.data?.cash_balance}`);

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 6. COACHING — picks the right single lesson for a planted pattern, silent below threshold ████");
  // ════════════════════════════════════════════════════════════════════
  const lessonUser = await createUser("lesson", stamp);
  console.log("  Planting a clean REVENGE-TRADING signature (size-based, not time-based — safe to construct instantly):");
  console.log("  5 losses on 5 distinct symbols, each immediately followed by 3 oversized re-entries on fresh symbols.");
  for (let i = 0; i < 5; i++) {
    const lossSym = `LSN${i}A`;
    await step(`lesson: loss #${i + 1} entry (${lossSym}, $200 baseline)`, () => buy(lessonUser.uid, lossSym, 2, 100));
    await step(`lesson: loss #${i + 1} exit at -5%`, () => sell(lessonUser.uid, lossSym, 2, 95));
    for (let j = 0; j < 3; j++) {
      const reentrySym = `LSN${i}B${j}`;
      await step(`lesson: post-loss re-entry ${i + 1}.${j + 1} (${reentrySym}, $600 — 3x baseline)`, () => buy(lessonUser.uid, reentrySym, 6, 100));
    }
  }
  const lessonTxRes = await step("admin: read lesson-user's real transactions", () => admin.from("transactions").select("*").eq("user_id", lessonUser.uid));
  if (lessonTxRes.error) throw new Error(lessonTxRes.error.message);
  const lessonAnalytics = computeBehavioralAnalytics({
    transactions: lessonTxRes.data as Transaction[],
    optionTransactions: [],
    notedTransactionIds: new Set(),
    notedOptionTransactionIds: new Set(),
  });
  console.log("  revengeTrading:", JSON.stringify(lessonAnalytics.revengeTrading));
  console.log("  disposition:", JSON.stringify(lessonAnalytics.disposition));
  console.log("  concentration pctOfTimeOverThreshold:", lessonAnalytics.concentration.available ? lessonAnalytics.concentration.data.pctOfTimeOverThreshold : "n/a");
  assert("lesson-user: revenge trading available and TRIGGERED (sizedUpAfterLoss)", lessonAnalytics.revengeTrading.available === true && lessonAnalytics.revengeTrading.data.sizedUpAfterLoss === true);
  assert("lesson-user: disposition honestly unavailable (0 winning closes — real trades happened in seconds, no time-based pattern was plantable)", lessonAnalytics.disposition.available === false);
  const topLesson = pickTopLesson(lessonAnalytics);
  assert("lesson-user: pickTopLesson picks EXACTLY 'revengeTrading' — the one real pattern, nothing else drowns it out", topLesson === "revengeTrading", `got ${topLesson}`);

  const sparseUser = await createUser("sparse", stamp);
  await step("sparse-user: one small trade, nowhere near any threshold", () => buy(sparseUser.uid, "SPARSE1", 1, 50));
  const sparseTxRes = await step("admin: read sparse-user's transactions", () => admin.from("transactions").select("*").eq("user_id", sparseUser.uid));
  if (sparseTxRes.error) throw new Error(sparseTxRes.error.message);
  const sparseAnalytics = computeBehavioralAnalytics({ transactions: sparseTxRes.data as Transaction[], optionTransactions: [], notedTransactionIds: new Set(), notedOptionTransactionIds: new Set() });
  const sparseLesson = pickTopLesson(sparseAnalytics);
  assert("sparse-user: pickTopLesson is null — silence below threshold, never a shaky lesson", sparseLesson === null, `got ${sparseLesson}`);

  // ════════════════════════════════════════════════════════════════════
  console.log("\n████ 7. THE THESIS TEST — diligent-but-losing must NOT rank below lucky-but-careless ████");
  // ════════════════════════════════════════════════════════════════════
  const diligent = await createUser("diligent-loser", stamp);
  const careless = await createUser("careless-winner", stamp);

  console.log("  Diligent-loser: 6 distinct symbols, journals, diversified holdings — but every closed trade LOSES money.");
  for (let i = 0; i < 4; i++) {
    const sym = `DILA${i}`;
    await step(`diligent: round-trip #${i + 1} on ${sym} at a LOSS`, async () => {
      await buy(diligent.uid, sym, 10, 100);
      await sell(diligent.uid, sym, 10, 98); // -2%, a real realized loss
    });
  }
  await step("diligent: buy #5 (open position, held) — DILE", () => buy(diligent.uid, "DILE", 5, 100));
  await step("diligent: buy #6 (open position, held) — DILF", () => buy(diligent.uid, "DILF", 5, 100));
  const diligentClient = await step("sign in as diligent-loser (own session, for journal writes)", () => signIn(diligent.email));
  for (let i = 0; i < 3; i++) {
    const r = await step(`diligent: write journal entry #${i + 1} (own RLS-scoped session)`, () => diligentClient.from("journal_entries").insert({ user_id: diligent.uid, body: `Reasoning for trade ${i + 1} — verification harness.` }).select("id").single());
    if (r.error) throw new Error("journal insert failed: " + r.error.message);
  }

  console.log("  Careless-winner: 1 symbol, no journal, high turnover, concentrated — but every closed trade WINS money.");
  for (let i = 0; i < 9; i++) {
    await step(`careless: round-trip #${i + 1} on CARE at a GAIN`, async () => {
      await buy(careless.uid, "CARE", 10, 100);
      await sell(careless.uid, "CARE", 10, 102); // +2%, a real realized gain
    });
  }
  await step("careless: one more open buy on the SAME symbol (still concentrated)", () => buy(careless.uid, "CARE", 5, 100));

  const diligentClient2 = await step("sign in as diligent-loser (fresh session, for the real read)", () => signIn(diligent.email));
  const carelessClient = await step("sign in as careless-winner (fresh session, for the real read)", () => signIn(careless.email));
  const diligentInputs = await step("read diligent-loser's real ExperienceInputs", () => readExperienceInputs(diligentClient2, diligent.uid));
  const carelessInputs = await step("read careless-winner's real ExperienceInputs", () => readExperienceInputs(carelessClient, careless.uid));
  console.log("  diligent-loser inputs:", JSON.stringify(diligentInputs));
  console.log("  careless-winner inputs:", JSON.stringify(carelessInputs));

  const diligentTxRes = await step("admin: read diligent-loser's real transactions (for real P&L)", () => admin.from("transactions").select("*").eq("user_id", diligent.uid));
  const carelessTxRes = await step("admin: read careless-winner's real transactions (for real P&L)", () => admin.from("transactions").select("*").eq("user_id", careless.uid));
  if (diligentTxRes.error || carelessTxRes.error) throw new Error("tx read failed");
  const realizedPnL = (txns: Transaction[]) => {
    const bySymbol = new Map<string, { qty: number; avgCost: number }>();
    let pnl = 0;
    for (const t of [...txns].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())) {
      const st = bySymbol.get(t.symbol) ?? { qty: 0, avgCost: 0 };
      if (t.side === "buy") {
        const newQty = st.qty + t.quantity;
        st.avgCost = newQty > 0 ? (st.qty * st.avgCost + t.quantity * t.price) / newQty : t.price;
        st.qty = newQty;
      } else {
        pnl += (t.price - st.avgCost) * t.quantity;
        st.qty -= t.quantity;
      }
      bySymbol.set(t.symbol, st);
    }
    return pnl;
  };
  const diligentPnL = realizedPnL(diligentTxRes.data as Transaction[]);
  const carelessPnL = realizedPnL(carelessTxRes.data as Transaction[]);
  console.log(`  diligent-loser realized P&L: $${diligentPnL.toFixed(2)}  |  careless-winner realized P&L: $${carelessPnL.toFixed(2)}`);
  assert("ground truth: diligent-loser is REALLY down money", diligentPnL < 0, `$${diligentPnL.toFixed(2)}`);
  assert("ground truth: careless-winner is REALLY up money", carelessPnL > 0, `$${carelessPnL.toFixed(2)}`);

  const diligentLevel = computeExperienceLevel(diligentInputs);
  const carelessLevel = computeExperienceLevel(carelessInputs);
  const RANK: Record<string, number> = { new: 0, developing: 1, experienced: 2 };
  console.log(`  diligent-loser level: ${diligentLevel.level}  |  careless-winner level: ${carelessLevel.level}`);
  assert("THESIS: diligent-loser's level is NOT LOWER than careless-winner's, despite losing money", RANK[diligentLevel.level] >= RANK[carelessLevel.level], `${diligentLevel.level} vs ${carelessLevel.level}`);
  assert("THESIS (strong form, given how these were constructed): diligent-loser actually ranks HIGHER — broader real activity, while losing", RANK[diligentLevel.level] > RANK[carelessLevel.level], `${diligentLevel.level} vs ${carelessLevel.level}`);
  assert("diligent-loser cleared journalling bar (3 entries)", diligentLevel.criteria.find((c) => c.key === "journalEntryCount")!.metDeveloping === true);
  assert("careless-winner did NOT clear journalling bar (0 entries)", carelessLevel.criteria.find((c) => c.key === "journalEntryCount")!.metDeveloping === false);
  assert("careless-winner did NOT clear diversification bar (1 symbol only)", carelessLevel.criteria.find((c) => c.key === "distinctInstrumentsUsed")!.metDeveloping === false);
  // Structural proof, not just this instance: ExperienceInputs itself carries
  // no price/return/balance field, so no level computation could ever read one.
  assert("structural: ExperienceInputs has exactly the 4 documented behavioural fields, no P&L field", Object.keys(diligentInputs).sort().join(",") === "currentDistinctHoldings,distinctInstrumentsUsed,journalEntryCount,tradesPlaced");

  console.log("\n████ Cleanup ████");
  for (const uid of created) {
    await admin.auth.admin.deleteUser(uid);
  }
  console.log(`  deleted ${created.length} throwaway users (cascades transactions/option_transactions/margin_events/journal_entries/holdings via FK)`);
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
    for (const uid of created) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch {
        /* best effort */
      }
    }
    process.exit(1);
  });
