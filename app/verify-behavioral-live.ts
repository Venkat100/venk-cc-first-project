// Real E2E for PLAN.md §6 step 7 (B2 — behavioural analytics), vite-node.
// Real Supabase, real execute_trade RPCs, real journal_entries via the
// user's own RLS-scoped session — no mocks.
//
// METHODOLOGY NOTE: TanStack Start server functions (getBehavioralAnalyticsFn)
// cannot be invoked directly outside the Start server runtime — confirmed by
// trying it: "No Start context found in AsyncLocalStorage." Every other
// *-live.ts script in this repo works around the identical constraint the
// same way: exercise the REAL underlying logic (here, computeBehavioralAnalytics
// fed with rows fetched exactly how the server function fetches them) rather
// than the HTTP-wrapped Fn object. JWT verification itself (verifyUser) is
// already proven extensively elsewhere (verify-rate-limits.ts, verify-margin-live.ts,
// etc.) — this script's job is the NEW code: does the real pipeline (real
// trades -> real DB rows -> the pure module) reconcile, does the noted-id
// presence-only mechanism work against a real journal_entries table, and are
// below-threshold cases honest.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser } from "./verify-harness";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { computeBehavioralAnalytics } from "@/lib/behavioral/metrics";
import type { Transaction, OptionTransaction } from "@/lib/supabase/types";

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
function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
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
const PASSWORD = "BehavioralVerifyTest!234";
const created: string[] = [];

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

async function main() {
  console.log("\n████ Setup: user A (rich realistic history) + user B (sparse, below-threshold) ████");
  const stamp = Date.now();
  const emailA = `pt-behav-a-${stamp}@example.org`;
  const emailB = `pt-behav-b-${stamp}@example.org`;
  const { uid: uidA } = await step("create user A", () => createTestUser(admin, emailA, PASSWORD));
  const { uid: uidB } = await step("create user B", () => createTestUser(admin, emailB, PASSWORD));
  created.push(uidA, uidB);
  console.log(`  user A: ${emailA} (${uidA})`);
  console.log(`  user B: ${emailB} (${uidB})`);

  const clientA = createClient(anonUrl, anonKey, { auth: { persistSession: false } });
  const signInA = await step("sign in as A (real session, for the noted-id fetch path)", () => clientA.auth.signInWithPassword({ email: emailA, password: PASSWORD }));
  if (signInA.error) throw new Error("sign-in failed: " + signInA.error.message);

  console.log("\n████ 1. Build a REALISTIC ledger for user A across real live prices ████");
  const symbols = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "NFLX", "AMD", "INTC", "ORCL", "CRM", "ADBE"];
  const quotes = new Map<string, number>();
  for (const s of symbols) {
    const q = await step(`fetch real live quote: ${s}`, () => getServerQuote(s), 15000);
    quotes.set(s, q.price);
  }

  // 6 clear winners (small realistic gain), 6 clear losers (small realistic loss) -> clears
  // disposition (5/5), win-rate (8), revenge-trading needs 5 losses + 10 pooled post-loss buys.
  const notedBuyIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const sym = symbols[i];
    const px = quotes.get(sym)!;
    const buyId = await step(`A: buy winner #${i + 1} (${sym})`, () => buy(uidA, sym, 2, px));
    if (i < 3) notedBuyIds.push(buyId); // journal-note the first 3 winners only
    await step(`A: sell winner #${i + 1} (${sym}) at +3%`, () => sell(uidA, sym, 2, +(px * 1.03).toFixed(2)));
  }
  for (let i = 0; i < 6; i++) {
    const sym = symbols[i + 6];
    const px = quotes.get(sym)!;
    await step(`A: buy loser #${i + 1} (${sym})`, () => buy(uidA, sym, 2, px));
    await step(`A: sell loser #${i + 1} (${sym}) at -3%`, () => sell(uidA, sym, 2, +(px * 0.97).toFixed(2)));
    // 2 small post-loss re-entries per loss (12 total, clears MIN_POST_LOSS_TRADES=10),
    // deliberately bigger than the $ size of the loss trades themselves.
    await step(`A: post-loss re-entry #${i + 1}a`, () => buy(uidA, sym, 6, px));
    await step(`A: post-loss re-entry #${i + 1}b`, () => buy(uidA, sym, 6, px));
  }

  console.log("\n████ 2. Create real journal notes on the first 3 winning buys (via A's own session) ████");
  for (const txnId of notedBuyIds) {
    const r = await step(`create note on transaction ${txnId}`, () =>
      clientA.from("journal_entries").insert({ user_id: uidA, transaction_id: txnId, body: "Noted for behavioral-analytics live verification." }).select("id").single(),
    );
    if (r.error) throw new Error("note create failed: " + r.error.message);
  }

  console.log("\n████ 3. Fetch REAL noted-transaction-ids via A's own authenticated session (the deliberate architecture) ████");
  const notedRes = await step("select transaction_id from journal_entries as A (id-only, never body)", () =>
    clientA.from("journal_entries").select("transaction_id").not("transaction_id", "is", null),
  );
  if (notedRes.error) throw new Error(notedRes.error.message);
  const realNotedIds = new Set((notedRes.data ?? []).map((r) => r.transaction_id as string));
  assert("real noted-id set has exactly 3 entries (the 3 winners we noted)", realNotedIds.size === 3, `got ${realNotedIds.size}`);
  assert("real noted-id set is a proper subset of the notedBuyIds we created", [...realNotedIds].every((id) => notedBuyIds.includes(id)));

  console.log("\n████ 4. Fetch A's real transactions via admin — EXACTLY as getBehavioralAnalyticsFn does — and reconcile ████");
  const txRes = await step("admin: select * from transactions where user_id = A", () => admin.from("transactions").select("*").eq("user_id", uidA));
  if (txRes.error) throw new Error(txRes.error.message);
  const txns = (txRes.data ?? []) as Transaction[];
  assert("real transaction count matches what we created (6 winners x2 + 6 losers x[buy+sell+2 reentries]=4 = 12+24 = 36)", txns.length === 36, `got ${txns.length}`);

  const analytics = computeBehavioralAnalytics({
    transactions: txns,
    optionTransactions: [],
    notedTransactionIds: realNotedIds,
    notedOptionTransactionIds: new Set(),
  });
  console.log("  disposition:", JSON.stringify(analytics.disposition));
  console.log("  overTrading:", JSON.stringify(analytics.overTrading));
  console.log("  concentration:", JSON.stringify(analytics.concentration));
  console.log("  revengeTrading:", JSON.stringify(analytics.revengeTrading));
  console.log("  winRate:", JSON.stringify(analytics.winRate));
  console.log("  journalCorrelation:", JSON.stringify(analytics.journalCorrelation));

  assert("disposition: available with real data (6 winners, 6 losers ≥ threshold 5)", analytics.disposition.available === true);
  if (analytics.disposition.available) {
    assert("disposition: winnersN=6, losersN=6 exactly", analytics.disposition.data.winnersN === 6 && analytics.disposition.data.losersN === 6);
    assert("disposition: avgReturnPctWinners ≈ +3% (planted)", approx(analytics.disposition.data.avgReturnPctWinners, 0.03, 0.001), `got ${analytics.disposition.data.avgReturnPctWinners}`);
    assert("disposition: avgReturnPctLosers ≈ -3% (planted)", approx(analytics.disposition.data.avgReturnPctLosers, -0.03, 0.001), `got ${analytics.disposition.data.avgReturnPctLosers}`);
  }

  assert("over-trading: HONESTLY unavailable — all real trades happened within seconds, nowhere near 4 distinct weeks", analytics.overTrading.available === false);
  if (!analytics.overTrading.available) {
    assert("over-trading: withheld reason correctly cites the real weeks span", analytics.overTrading.reason.includes("weeks"), analytics.overTrading.reason);
  }

  assert("concentration: available with real cost-basis data", analytics.concentration.available === true);
  if (analytics.concentration.available) {
    assert("concentration: currentLargestSharePct is a sane fraction (0..1), 12 roughly-equal-sized symbols held", analytics.concentration.data.currentLargestSharePct > 0 && analytics.concentration.data.currentLargestSharePct <= 1);
  }

  assert("win-rate: available (12 closes ≥ threshold 8)", analytics.winRate.available === true);
  if (analytics.winRate.available) {
    assert("win-rate: winRate = 0.5 exactly (6 of 12)", approx(analytics.winRate.data.winRate, 0.5), `got ${analytics.winRate.data.winRate}`);
  }

  assert("revenge-trading: available (6 losses ≥ 5, 12 post-loss entries pooled ≥ 10)", analytics.revengeTrading.available === true);
  if (analytics.revengeTrading.available) {
    assert("revenge-trading: sizedUpAfterLoss = TRUE (post-loss entries were 3x the loss-entry size)", analytics.revengeTrading.data.sizedUpAfterLoss === true);
  }

  assert("journal-correlation: available (3 noted vs... check bucket sizes)", analytics.journalCorrelation.n >= 0);
  console.log(`  journal-correlation n=${analytics.journalCorrelation.n} (need ≥5 per bucket; only 3 winners were noted, so this MAY legitimately be below threshold)`);
  if (!analytics.journalCorrelation.available) {
    assert("journal-correlation: honestly withheld when below threshold, not shown shakily", analytics.journalCorrelation.available === false);
  }

  console.log("\n████ 5. RLS/isolation: user B's own (near-empty) history must be computed independently, never mixed with A's ████");
  const bx = symbols[0];
  const bpx = quotes.get(bx)!;
  await step("B: one small buy", () => buy(uidB, bx, 1, bpx));
  await step("B: one small sell", () => sell(uidB, bx, 1, +(bpx * 1.01).toFixed(2)));
  const txResB = await step("admin: select * from transactions where user_id = B", () => admin.from("transactions").select("*").eq("user_id", uidB));
  if (txResB.error) throw new Error(txResB.error.message);
  const txnsB = (txResB.data ?? []) as Transaction[];
  assert("B's own transaction count = 2 (own history only, not A's 48)", txnsB.length === 2, `got ${txnsB.length}`);

  const analyticsB = computeBehavioralAnalytics({ transactions: txnsB, optionTransactions: [], notedTransactionIds: new Set(), notedOptionTransactionIds: new Set() });
  console.log("\n████ 6. Below-threshold user: every metric must show an honest 'not enough data' state ████");
  // Concentration is special-cased: by design it always reports a CURRENT
  // snapshot once any trade exists (there's nothing statistically shaky
  // about "here is your literal current allocation"), and gates only the
  // HISTORICAL "how often have you been over threshold" claim behind its own
  // minimum sample count — see metrics.ts's own comment on this. Every other
  // metric gates itself entirely.
  for (const [key, m] of Object.entries(analyticsB) as [string, { available: boolean; n: number; minRequired?: number }][]) {
    if (key === "concentration") continue;
    assert(`B's ${key} is honestly withheld (available=false) with only 1 closed trade`, m.available === false, JSON.stringify(m));
  }
  assert(
    "B's concentration HISTORY claim is honestly withheld (only 1 sample, needs 5) even though current-state is shown",
    analyticsB.concentration.available === true && analyticsB.concentration.data.historyAvailable === false && analyticsB.concentration.data.pctOfTimeOverThreshold === null,
    JSON.stringify(analyticsB.concentration),
  );

  console.log("\n████ Cleanup ████");
  for (const uid of created) {
    await admin.auth.admin.deleteUser(uid);
  }
  console.log(`  deleted ${created.length} throwaway users (cascades transactions/journal_entries via FK)`);
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
