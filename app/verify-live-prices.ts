// Real E2E capacity proof for PLAN.md §6 step 3 (live prices). Real Finnhub
// quotes, real Postgres price_cache, real timers — no mocks. Hardened
// harness (per-step timeouts, timestamped logging, foreground pty,
// try/catch + process.exit) per the standing HANDOFF rule.
//
// This proves the HEADLINE claim: client polling (15s, useQuotes.ts) against
// the server TTL (30s, cache.server.ts TTL.quote) means N concurrent users
// watching the SAME symbol cost ~1 provider call per 30s REGARDLESS of N,
// and cost scales with DISTINCT SYMBOLS, not user count. Both scenarios call
// getServerQuote() directly — the exact function getQuotesFn (what the
// client's useQuotes hook actually calls) delegates to per symbol — so this
// exercises the real L1+L2 cache path, just without the HTTP/React round
// trip.
//
// isUsMarketOpen's day/hour boundaries are also verified here since they're
// a pure function with no server-only deps. The client-side halves of the
// two efficiency gates (tab-hidden, market-closed → refetchInterval: false)
// are React/browser concerns and are verified separately in-browser
// (network-request inspection), not here.

import { getServerQuote } from "@/lib/marketData/quote.server";
import { fetchStats, resetFetchStats } from "@/lib/marketData/finnhub.server";
import { __clearL1ForTest } from "@/lib/marketData/cache.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { isUsMarketOpen } from "@/lib/marketData/marketHours";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
}
async function step<T>(label: string, fn: () => Promise<T>, ms = 20000): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const admin = getServiceClient();

// Mirrors useQuotes.ts's QUOTE_POLL_MS — not exported from that client-only
// module, so restated here with the same value + citation.
const CLIENT_POLL_MS = 15_000; // useQuotes.ts QUOTE_POLL_MS
const SERVER_TTL_MS = 30_000; // cache.server.ts TTL.quote

/** Simulate one "browser tab" polling getServerQuote(symbol) on the same
 *  cadence useQuotes.ts's refetchInterval uses, for durationMs wall-clock
 *  time. Does NOT clear L1 between polls (a real persistent Node process
 *  keeps L1 warm across requests from different users — L1 dying is a
 *  serverless-cold-start concern, already proven separately in
 *  verify-price-cache.ts). Fires an immediate poll at t=0 like react-query
 *  does on mount, then one every CLIENT_POLL_MS. */
async function simulateUser(symbol: string, durationMs: number): Promise<number> {
  let polls = 0;
  const deadline = Date.now() + durationMs;
  for (;;) {
    await getServerQuote(symbol);
    polls++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(CLIENT_POLL_MS, remaining));
  }
  return polls;
}

async function main() {
  console.log("\n████ 0. Clean slate ████");
  await step("clear L1 + delete relevant price_cache rows", async () => {
    __clearL1ForTest();
    await admin.from("price_cache").delete().eq("kind", "quote").in("symbol", ["MSFT", "GOOGL", "AMZN", "META", "NFLX", "ORCL"]);
  });

  console.log("\n████ 1. HEADLINE: 20 concurrent users, SAME symbol, 2 minutes real time ████");
  console.log(`  arithmetic: poll every ${CLIENT_POLL_MS / 1000}s against a ${SERVER_TTL_MS / 1000}s server TTL ⇒`);
  console.log(`  expect ⌈120s / ${SERVER_TTL_MS / 1000}s⌉ = 4 provider calls total, NOT 20×8=160 (one per user poll)`);
  const SYMBOL_A = "MSFT";
  const DURATION_MS = 120_000;
  const USERS_A = 20;

  resetFetchStats();
  const beforeA = fetchStats();
  const t0 = Date.now();
  const pollCounts = await step(
    `${USERS_A} concurrent simulated users polling ${SYMBOL_A} for 2 minutes`,
    () => Promise.all(Array.from({ length: USERS_A }, () => simulateUser(SYMBOL_A, DURATION_MS))),
    DURATION_MS + 30_000,
  );
  const elapsed = Date.now() - t0;
  const afterA = fetchStats();
  const providerCallsA = afterA.quotes - beforeA.quotes;
  const totalPolls = pollCounts.reduce((a, b) => a + b, 0);
  console.log(`  elapsed: ${elapsed}ms; total client-side polls across all users: ${totalPolls}; provider calls: ${providerCallsA}`);
  assert(
    `provider calls (${providerCallsA}) are ~4, and NOT anywhere near total polls (${totalPolls})`,
    providerCallsA >= 3 && providerCallsA <= 6,
    `beforeA=${JSON.stringify(beforeA)} afterA=${JSON.stringify(afterA)}`,
  );
  assert("provider calls did not scale with user count (20 users ≠ 20+ calls)", providerCallsA < USERS_A);

  console.log("\n████ 2. SCALING: 5 distinct symbols, 4 users each (20 users total), 2 minutes real time ████");
  console.log(`  expect calls to scale with SYMBOL COUNT (5), not user count (20): ~4 calls × 5 symbols = ~20 total`);
  const SYMBOLS_B = ["GOOGL", "AMZN", "META", "NFLX", "ORCL"];
  const USERS_PER_SYMBOL = 4;

  await step("clear L1 before scenario 2 (fresh TTL windows, isolate from scenario 1)", async () => {
    __clearL1ForTest();
  });
  const beforeB = fetchStats();
  const t1 = Date.now();
  const pollCountsB = await step(
    `${SYMBOLS_B.length} symbols × ${USERS_PER_SYMBOL} users each polling for 2 minutes`,
    () =>
      Promise.all(
        SYMBOLS_B.flatMap((sym) => Array.from({ length: USERS_PER_SYMBOL }, () => simulateUser(sym, DURATION_MS))),
      ),
    DURATION_MS + 30_000,
  );
  const elapsedB = Date.now() - t1;
  const afterB = fetchStats();
  const providerCallsB = afterB.quotes - beforeB.quotes;
  const totalPollsB = pollCountsB.reduce((a, b) => a + b, 0);
  const totalUsersB = SYMBOLS_B.length * USERS_PER_SYMBOL;
  console.log(`  elapsed: ${elapsedB}ms; total client-side polls: ${totalPollsB}; provider calls: ${providerCallsB}`);
  const expectedPerSymbol = Math.ceil(DURATION_MS / SERVER_TTL_MS); // ~4
  const expectedTotalB = expectedPerSymbol * SYMBOLS_B.length; // ~20
  assert(
    `provider calls (${providerCallsB}) are ~${expectedTotalB} (≈${expectedPerSymbol}/symbol × ${SYMBOLS_B.length} symbols)`,
    providerCallsB >= SYMBOLS_B.length * 3 && providerCallsB <= SYMBOLS_B.length * 6,
    `beforeB=${JSON.stringify(beforeB)} afterB=${JSON.stringify(afterB)}`,
  );
  // NOTE: a "providerCallsB < totalUsersB" check used to live here too, but it
  // was a redundant, boundary-fragile proxy for the same claim the two
  // assertions above/below already prove robustly. With 5 symbols × 4
  // users/symbol = 20 total users, and an expected-healthy cost of ~4 TTL
  // crossings/symbol × 5 symbols ≈ 20 calls, the "healthy" value coincides
  // almost exactly with the failure threshold — any run where real Finnhub
  // latency tips just ONE symbol's 120s polling loop into a 5th TTL window
  // (20→21, still inside the healthy 15-30 band checked above) failed this
  // extra check for no real reason. Root-caused 2026-08-10: not a caching
  // regression (cache.server.ts/quote.server.ts/finnhub.server.ts unchanged
  // since before this test existed) — removed rather than re-thresholded,
  // since the assertion below already proves "scales with symbols, not
  // users" correctly by holding user count constant (20) across scenarios
  // A and B while varying symbol count (1 vs 5).
  assert(
    "5-symbol scenario cost ~5× the 1-symbol scenario's provider calls (scales with symbols, not users — both had 20 users)",
    providerCallsB >= providerCallsA * 3,
    `A=${providerCallsA} B=${providerCallsB}`,
  );

  console.log("\n████ 3. isUsMarketOpen correctness — pure-function boundary checks ████");
  // All times constructed as UTC instants that map to specific America/New_York
  // wall-clock times, covering both DST regimes (EDT=UTC-4 summer, EST=UTC-5 winter)
  // so the Intl-based DST handling is actually exercised, not just assumed.
  const cases: { label: string; date: Date; expected: boolean }[] = [
    { label: "Wed 2026-08-12 10:00 ET (EDT, mid-session)", date: new Date("2026-08-12T14:00:00Z"), expected: true },
    { label: "Wed 2026-08-12 09:29 ET (EDT, 1min before open)", date: new Date("2026-08-12T13:29:00Z"), expected: false },
    { label: "Wed 2026-08-12 09:30 ET (EDT, exact open)", date: new Date("2026-08-12T13:30:00Z"), expected: true },
    { label: "Wed 2026-08-12 15:59 ET (EDT, 1min before close)", date: new Date("2026-08-12T19:59:00Z"), expected: true },
    { label: "Wed 2026-08-12 16:00 ET (EDT, exact close)", date: new Date("2026-08-12T20:00:00Z"), expected: false },
    { label: "Wed 2026-08-12 03:00 ET (EDT, overnight)", date: new Date("2026-08-12T07:00:00Z"), expected: false },
    { label: "Sat 2026-08-15 10:00 ET (EDT, weekend)", date: new Date("2026-08-15T14:00:00Z"), expected: false },
    { label: "Sun 2026-08-16 10:00 ET (EDT, weekend)", date: new Date("2026-08-16T14:00:00Z"), expected: false },
    { label: "Wed 2026-01-14 10:00 ET (EST, mid-session, winter DST regime)", date: new Date("2026-01-14T15:00:00Z"), expected: true },
    { label: "Wed 2026-01-14 09:29 ET (EST, 1min before open)", date: new Date("2026-01-14T14:29:00Z"), expected: false },
    { label: "Wed 2026-01-14 16:00 ET (EST, exact close)", date: new Date("2026-01-14T21:00:00Z"), expected: false },
  ];
  for (const c of cases) {
    const got = isUsMarketOpen(c.date);
    assert(`${c.label} → ${c.expected}`, got === c.expected, `got ${got}`);
  }

  console.log("\n████ Cleanup ████");
  await step("delete test price_cache rows", () =>
    admin.from("price_cache").delete().eq("kind", "quote").in("symbol", ["MSFT", "GOOGL", "AMZN", "META", "NFLX", "ORCL"]),
  );
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
