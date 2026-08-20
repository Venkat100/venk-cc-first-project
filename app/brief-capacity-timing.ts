// Before/after capacity-measurement script for the 2026-08-19 incident's
// follow-up (HANDOFF.md — full writeup there). runDailyBriefs() now runs
// on its OWN GitHub Actions schedule (/api/cron/agent-brief), subject to
// the SAME 300s Vercel Hobby ceiling as agent-thinker, just no longer
// SHARING that ceiling with 13 agents' worth of Claude calls — AND, as of
// this round, uses the SAME shuffle + bounded-concurrency treatment
// (batchUtils.ts) already proven on agent-thinker, since it turned out to
// be the tighter capacity constraint of the two (PLAN.md §6g).
//
// BEFORE here means "one user at a time" — calling the real, current
// `runDailyBriefs({onlyUserIds:[id]})` once per user in a loop, which
// exercises the exact same per-user Claude+Finnhub logic the old plain
// sequential loop did. Honest caveat: this re-runs the (cheap) holdings/
// watchlist read on every call instead of once for the whole batch the
// way the real original loop did — negligible next to the ~12s/user
// Claude+Finnhub cost this measurement is actually about, but stated
// plainly rather than claimed away.
//
// DELIBERATELY named without a `verify-` prefix — see
// thinker-concurrency-timing.ts's header for why (one-time measurement,
// real Claude+Finnhub cost, not a correctness regression test).
//
// SAFETY: creates its own throwaway @example.org users with real watchlist
// rows (2 real, distinct symbols each — enough to exercise the real
// per-symbol news-fetch path, not an unrealistic 1-symbol-thin case),
// never runs against real production users, deletes everything it created
// (auth user cascade removes the watchlist rows), success or failure.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser, runVerification, withRetry } from "./verify-harness";
import { runDailyBriefs } from "@/lib/insights/insights.server";

const USER_COUNT = 15; // ~2x today's real "usersConsidered" scale (7 real accounts, confirmed live), for a more informative measurement
const SYMBOL_PAIRS = [
  ["AAPL", "MSFT"], ["NVDA", "AMD"], ["TSLA", "GOOGL"], ["AMZN", "META"], ["VOO", "QQQ"],
  ["JPM", "BAC"], ["DIS", "NFLX"], ["KO", "PEP"], ["XOM", "CVX"], ["SOFI", "PYPL"],
  ["CRM", "ORCL"], ["INTC", "QCOM"], ["WMT", "COST"], ["V", "MA"], ["BA", "CAT"],
];
const stamp = Date.now();
const createdUserIds: string[] = [];

async function main() {
  const admin = getServiceClient();
  const envText = readFileSync(".env", "utf8");
  const env = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const anonUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  const PASSWORD = "HardenPass!234";

  console.log(`\n████ Setup: ${USER_COUNT} throwaway users, 2 real watchlist symbols each ████`);
  // watchlist only grants service_role SELECT (0009_insights.sql) — insert
  // must go through the user's own RLS-authorized session, same pattern
  // verify-hardening-cron-chain.ts already uses for owner-scoped writes.
  for (let i = 0; i < USER_COUNT; i++) {
    const email = `pt-brief-timing-${stamp}-${i}@example.org`;
    const { uid } = await withRetry(`create ${email}`, () => createTestUser(admin, email, PASSWORD));
    createdUserIds.push(uid);
    const client = createClient(anonUrl, anonKey);
    const signIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signIn.error) throw new Error(`sign-in failed for ${email}: ${signIn.error.message}`);
    const [a, b] = SYMBOL_PAIRS[i % SYMBOL_PAIRS.length];
    const { error } = await client.from("watchlist").insert([
      { user_id: uid, symbol: a },
      { user_id: uid, symbol: b },
    ]);
    if (error) throw new Error(`watchlist seed failed for ${email}: ${error.message}`);
  }
  console.log(`  created ${createdUserIds.length} users with real watchlist symbols`);

  console.log(`\n████ BEFORE: one user at a time (real runDailyBriefs({onlyUserIds:[id]}) looped) ████`);
  const beforeStart = Date.now();
  let beforeWritten = 0;
  for (const uid of createdUserIds) {
    console.log(`  [${new Date().toISOString().slice(11, 23)}] -> runDailyBriefs({onlyUserIds:[${uid}]})`);
    const r = await runDailyBriefs({ onlyUserIds: [uid] });
    beforeWritten += r.briefsWritten;
    console.log(`  [${new Date().toISOString().slice(11, 23)}] <- briefsWritten=${r.briefsWritten} errors=${r.errors.length}`);
  }
  const beforeMs = Date.now() - beforeStart;
  console.log(`  BEFORE total: ${beforeMs}ms (${(beforeMs / 1000).toFixed(1)}s) across ${createdUserIds.length} users, ${beforeWritten} briefs written`);

  console.log(`\n████ AFTER: real runDailyBriefs (shuffle + bounded concurrency=5), all users in one batch ████`);
  const afterStart = Date.now();
  const summary = await runDailyBriefs({ onlyUserIds: createdUserIds });
  const afterMs = Date.now() - afterStart;
  console.log(`  AFTER total: ${afterMs}ms (${(afterMs / 1000).toFixed(1)}s) for ${summary.usersConsidered} users — briefsWritten=${summary.briefsWritten} skipped=${summary.skipped} errors=${summary.errors.length}`);

  const speedup = beforeMs / afterMs;
  console.log(`\n████ RESULT ████`);
  console.log(`  BEFORE (one at a time): ${(beforeMs / 1000).toFixed(1)}s  (${(beforeMs / createdUserIds.length / 1000).toFixed(2)}s/user average)`);
  console.log(`  AFTER  (concurrency=5): ${(afterMs / 1000).toFixed(1)}s  (${(afterMs / summary.usersConsidered / 1000).toFixed(2)}s/user average)`);
  console.log(`  speedup: ${speedup.toFixed(2)}x`);
  console.log(`  AFTER vs. Vercel Hobby's 300s hard ceiling: ${((afterMs / 1000 / 300) * 100).toFixed(1)}% of budget used`);

  if (summary.errors.length) {
    console.log(`  NOTE: ${summary.errors.length} per-user error(s) in the AFTER run (isolated, did not abort the batch):`);
    for (const e of summary.errors) console.log(`    - ${e}`);
  }
}

runVerification(main, {
  globalTimeoutMs: 590_000,
  cleanup: async () => {
    const admin = getServiceClient();
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch (e) {
        console.error(`cleanup: failed to delete ${uid}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`  cleanup: deleted ${createdUserIds.length} throwaway users`);
  },
});
