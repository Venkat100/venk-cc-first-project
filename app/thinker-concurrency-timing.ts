// Concurrency-level measurement script for the 2026-08-19/21 incident
// (HANDOFF.md — full writeup there). Originally proved sequential vs.
// concurrency=5 (5.26x speedup, still true and unchanged). EXTENDED
// 2026-08-21 to answer a specific challenge: does raising concurrency
// further (8, 10) actually buy proportionally more throughput, or is
// there a real ceiling independent of the bound itself? Earlier reasoning
// in this file's history claimed Claude call latency wasn't "relieved" by
// more concurrency — that was WRONG (latency-bound batches are exactly
// what a bigger worker pool helps with, since more independent requests
// can be in flight at once) and is corrected here with real measurements
// rather than re-argued in prose.
//
// DELIBERATELY named without a `verify-` prefix — see this file's own
// prior header (git history) for why (one-time measurement, real
// Claude+Finnhub cost, not a correctness regression test). Run manually:
// `npx vite-node thinker-concurrency-timing.ts`.
//
// SAFETY: never runs against real production agents (see the same rule
// stated in verify-hardening-cron-chain.ts) — creates its OWN 13 throwaway
// @example.org agents (13 chosen to match today's real eligible-agent count,
// confirmed live against production: `agent_config` where enabled=true and
// agent_cash>0), funds and enables them, runs the SAME real
// runThinkerForAllAgents against them three times — concurrency 5, 8, 10 —
// reusing ONE shared universe prefetch across all three runs so the only
// variable being measured is the concurrency bound itself, then deletes
// every throwaway user it created, success or failure.
//
// Every call is a REAL Claude + Finnhub call (this script does not pass
// disableAi) — the whole point is to measure real latency, not a quant-only
// shortcut that would hide the exact cost concurrency is claimed to reduce.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser, runVerification, withRetry } from "./verify-harness";
import { prefetchUniverse } from "@/lib/agent/quant.server";
import { runThinkerForAllAgents } from "@/lib/agent/cron.server";

const AGENT_COUNT = 13; // matches real production eligible-agent count, checked live before writing this script
const CONCURRENCY_LEVELS = [5, 8, 10];
const HOBBY_CEILING_S = 300;
const stamp = Date.now();
const createdUserIds: string[] = [];

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

  console.log(`\n████ Shared universe prefetch (real, ONE fetch reused by every concurrency level so only the bound itself varies) ████`);
  const prefetch = await prefetchUniverse();

  const rows: Array<{ concurrency: number; ms: number; errors: number }> = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    console.log(`\n████ concurrency=${concurrency} ████`);
    const start = Date.now();
    const summary = await runThinkerForAllAgents({ onlyUserIds: createdUserIds, prefetch, concurrency });
    const ms = Date.now() - start;
    console.log(`  total: ${ms}ms (${(ms / 1000).toFixed(1)}s) — eligible=${summary.eligible} processed=${summary.processed} errors=${summary.errors.length}`);
    if (summary.errors.length) for (const e of summary.errors) console.log(`    error: ${e}`);
    rows.push({ concurrency, ms, errors: summary.errors.length });
  }

  console.log(`\n████ RESULT — real measured throughput at each concurrency level ████`);
  console.log(`  ${"concurrency".padEnd(12)}${"wall-clock".padEnd(14)}${"s/agent-equiv".padEnd(16)}${"derived ceiling".padEnd(18)}% of 300s budget`);
  for (const row of rows) {
    const perAgent = row.ms / 1000 / AGENT_COUNT;
    const ceiling = Math.floor(HOBBY_CEILING_S / perAgent);
    const pctBudget = ((row.ms / 1000 / HOBBY_CEILING_S) * 100).toFixed(1);
    console.log(`  ${String(row.concurrency).padEnd(12)}${(row.ms / 1000).toFixed(1).padEnd(6)}s      ${perAgent.toFixed(3).padEnd(16)}~${String(ceiling).padEnd(17)}${pctBudget}%`);
  }
  const base = rows[0];
  for (const row of rows.slice(1)) {
    const speedupVsBase = base.ms / row.ms;
    console.log(`  concurrency=${row.concurrency} vs concurrency=${base.concurrency}: ${speedupVsBase.toFixed(2)}x`);
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
