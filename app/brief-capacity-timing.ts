// One-shot capacity-measurement script for the 2026-08-19 incident's
// follow-up (HANDOFF.md — full writeup there). runDailyBriefs() runs a
// plain sequential per-user loop (no concurrency at all — it was never
// touched by the thinker's shuffle+bounded-concurrency fix) and, since
// 2026-08-19, executes as its OWN Vercel serverless function
// (/api/cron/agent-brief, triggered by GitHub Actions) — so it is subject
// to the SAME 300s Vercel Hobby ceiling as agent-thinker, just no longer
// SHARING that ceiling with 13 agents' worth of Claude calls. Nobody has
// measured what ITS ceiling actually is. This does.
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

  console.log(`\n████ Real runDailyBriefs({onlyUserIds}) — sequential, real Claude + Finnhub calls throughout ████`);
  const start = Date.now();
  const summary = await runDailyBriefs({ onlyUserIds: createdUserIds });
  const ms = Date.now() - start;
  console.log(`  total: ${ms}ms (${(ms / 1000).toFixed(1)}s) for ${summary.usersConsidered} users — briefsWritten=${summary.briefsWritten} skipped=${summary.skipped} errors=${summary.errors.length}`);
  console.log(`  per-user average: ${(ms / summary.usersConsidered / 1000).toFixed(2)}s`);
  console.log(`  vs. Vercel Hobby's 300s hard ceiling: ${((ms / 1000 / 300) * 100).toFixed(1)}% of budget used`);

  if (summary.errors.length) {
    console.log(`  NOTE: ${summary.errors.length} per-user error(s) (isolated, did not abort the batch):`);
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
