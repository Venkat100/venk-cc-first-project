// One-shot measurement script for the 2026-08-19 incident fix (HANDOFF.md —
// full writeup there). Proves, with real wall-clock numbers rather than
// theory, that bounded concurrency actually delivers the reduction the fix
// depends on.
//
// DELIBERATELY named without a `verify-` prefix so verify-suite.sh's glob
// does NOT pick it up: unlike the verify-hardening-*.ts scripts (which test
// a correctness invariant that could regress), this is a one-time
// measurement, and it does 26 real Claude + Finnhub calls (13 agents × 2
// runs) — a real recurring cost with no new information on repeat runs.
// Kept in the repo for a future re-measurement (e.g. after a concurrency
// bound change), run manually: `npx vite-node thinker-concurrency-timing.ts`.
//
// SAFETY: never runs against real production agents (see the same rule
// stated in verify-hardening-cron-chain.ts) — creates its OWN 13 throwaway
// @example.org agents (13 chosen to match today's real eligible-agent count,
// confirmed live against production: `agent_config` where enabled=true and
// agent_cash>0), funds and enables them, times the SAME shared prefetch run
// through (a) a plain sequential loop — exactly the loop shape
// runThinkerForAllAgents had BEFORE this fix — and (b) the real, current
// runThinkerForAllAgents (shuffle + bounded concurrency=5), then deletes
// every throwaway user it created, success or failure.
//
// Every call is a REAL Claude + Finnhub call (this script does not pass
// disableAi) — the whole point is to measure real latency, not a quant-only
// shortcut that would hide the exact cost concurrency is claimed to reduce.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser, runVerification, withRetry } from "./verify-harness";
import { prefetchUniverse } from "@/lib/agent/quant.server";
import { runThinker } from "@/lib/agent/thinker.server";
import { runThinkerForAllAgents } from "@/lib/agent/cron.server";

const AGENT_COUNT = 13; // matches real production eligible-agent count, checked live before writing this script
const stamp = Date.now();
const createdUserIds: string[] = [];

function ts() {
  return new Date().toISOString().slice(11, 23);
}

async function main() {
  const admin = getServiceClient();

  console.log(`\n████ Setup: ${AGENT_COUNT} throwaway funded+enabled agents ████`);
  for (let i = 0; i < AGENT_COUNT; i++) {
    const email = `pt-thinker-timing-${stamp}-${i}@example.org`;
    const { uid } = await withRetry(`create ${email}`, () => createTestUser(admin, email, "HardenPass!234"));
    createdUserIds.push(uid);
    const { error: cfgErr } = await admin.from("agent_config").upsert({ user_id: uid, enabled: true, mode: "autonomous", risk_level: "balanced" }, { onConflict: "user_id" });
    if (cfgErr) throw new Error(`agent_config upsert failed for ${email}: ${cfgErr.message}`);
    const { error: fundErr } = await admin.rpc("fund_agent", { p_user_id: uid, p_amount: 10000 });
    if (fundErr) throw new Error(`fund_agent failed for ${email}: ${fundErr.message}`);
  }
  console.log(`  created ${createdUserIds.length} agents`);

  console.log(`\n████ Shared universe prefetch (real, ONE fetch reused by both runs — matches production's own dedup) ████`);
  const prefetch = await prefetchUniverse();

  console.log(`\n████ BEFORE: sequential loop (the exact shape runThinkerForAllAgents had prior to this fix) ████`);
  const beforeStart = Date.now();
  let beforeRan = 0;
  for (const uid of createdUserIds) {
    console.log(`  [${ts()}] -> runThinker(${uid})`);
    const r = await runThinker(uid, { prefetch });
    if (r.ran || r.proposed) beforeRan++;
    console.log(`  [${ts()}] <- ran=${r.ran} proposed=${r.proposed ?? false} reason=${r.reason ?? ""}`);
  }
  const beforeMs = Date.now() - beforeStart;
  console.log(`  BEFORE total: ${beforeMs}ms (${(beforeMs / 1000).toFixed(1)}s) across ${createdUserIds.length} agents, ${beforeRan} produced a trade/proposal`);

  console.log(`\n████ AFTER: real runThinkerForAllAgents (shuffle + bounded concurrency=5) ████`);
  const afterStart = Date.now();
  const afterSummary = await runThinkerForAllAgents({ onlyUserIds: createdUserIds, prefetch });
  const afterMs = Date.now() - afterStart;
  console.log(`  AFTER total: ${afterMs}ms (${(afterMs / 1000).toFixed(1)}s) — eligible=${afterSummary.eligible} processed=${afterSummary.processed} errors=${afterSummary.errors.length}`);

  const speedup = beforeMs / afterMs;
  console.log(`\n████ RESULT ████`);
  console.log(`  BEFORE (sequential): ${(beforeMs / 1000).toFixed(1)}s`);
  console.log(`  AFTER  (concurrency=5): ${(afterMs / 1000).toFixed(1)}s`);
  console.log(`  speedup: ${speedup.toFixed(2)}x`);
  console.log(`  AFTER vs. Vercel Hobby's 300s hard ceiling: ${((afterMs / 1000 / 300) * 100).toFixed(1)}% of budget used`);

  if (afterSummary.errors.length) {
    console.log(`  NOTE: ${afterSummary.errors.length} per-agent error(s) in the AFTER run (isolated, did not abort the batch):`);
    for (const e of afterSummary.errors) console.log(`    - ${e}`);
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
    console.log(`  cleanup: deleted ${createdUserIds.length} throwaway agents`);
  },
});
