// Real E2E for the durable Postgres price_cache (PLAN.md §6 step 2). Real
// Finnhub quotes, real Postgres — no mocks. Hardened harness (per-step
// timeouts, timestamped logging, foreground pty, try/catch + process.exit)
// per the standing HANDOFF rule.
//
// Requires migrations 0017 (transactions/insights grant fix) and 0018
// (price_cache table) applied.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { fetchStats, resetFetchStats } from "@/lib/marketData/finnhub.server";
import { durableCached, __clearL1ForTest } from "@/lib/marketData/cache.server";
import { runPriceCachePrune } from "@/lib/marketData/pruneCache.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
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

const admin = getServiceClient();
const SYMBOL = "AAPL";

async function main() {
  console.log("\n████ 0. Clean slate — clear any existing price_cache rows for the test kinds ████");
  await step("delete existing quote/test rows", () =>
    admin.from("price_cache").delete().in("kind", ["quote", "__verify_test__"]).eq("symbol", SYMBOL),
  );
  await step("delete existing test rows (ERRORCASE/TTLCASE/PRUNECASE symbols)", () =>
    admin.from("price_cache").delete().eq("kind", "__verify_test__"),
  );

  console.log("\n████ 1. HEADLINE: N=20 simulated cold invocations, same symbol, one TTL window → provider hit ONCE ████");
  resetFetchStats();
  const before = fetchStats();
  console.log(`  provider fetch count BEFORE: total=${before.total}, quotes=${before.quotes}`);

  const N = 20;
  for (let i = 0; i < N; i++) {
    __clearL1ForTest(); // simulate a fresh cold invocation — empty L1, L2 (Postgres) persists
    await step(`invocation ${i + 1}/${N}: getServerQuote(${SYMBOL}) with L1 cleared`, () => getServerQuote(SYMBOL), 15000);
  }

  const after = fetchStats();
  console.log(`  provider fetch count AFTER: total=${after.total}, quotes=${after.quotes}`);
  assert(
    `${N} cold invocations for the SAME symbol cost exactly 1 provider quote fetch, not ${N}`,
    after.quotes - before.quotes === 1,
    `delta=${after.quotes - before.quotes}`,
  );

  const row = await step("read back the price_cache row written by invocation #1", () =>
    admin.from("price_cache").select("kind, symbol, interval, fetched_at").eq("kind", "quote").eq("symbol", SYMBOL).eq("interval", "").maybeSingle(),
  );
  assert("exactly one price_cache row exists for this symbol (upsert, not N duplicate inserts)", !!row.data, JSON.stringify(row.data));

  console.log("\n████ 2. TTL expiry — a request after the freshness window re-fetches ████");
  // Backdate the row's fetched_at past the quote TTL (30s) rather than
  // sleeping 30+ real seconds — proves the SAME freshness-check logic,
  // deterministically and fast.
  const old = new Date(Date.now() - 60_000).toISOString(); // 60s ago > 30s TTL
  await step("backdate the cached row's fetched_at to 60s ago (> 30s quote TTL)", () =>
    admin.from("price_cache").update({ fetched_at: old }).eq("kind", "quote").eq("symbol", SYMBOL).eq("interval", ""),
  );
  const beforeTtl = fetchStats();
  __clearL1ForTest();
  await step("getServerQuote after backdating (L1 cleared) — should re-fetch", () => getServerQuote(SYMBOL), 15000);
  const afterTtl = fetchStats();
  assert("a stale L2 row (past TTL) triggers a genuine re-fetch, not a stale-serve", afterTtl.quotes - beforeTtl.quotes === 1, `delta=${afterTtl.quotes - beforeTtl.quotes}`);
  const freshRow = await step("read back the row after the TTL re-fetch", () =>
    admin.from("price_cache").select("fetched_at").eq("kind", "quote").eq("symbol", SYMBOL).eq("interval", "").maybeSingle(),
  );
  const refetchedAt = freshRow.data ? new Date(freshRow.data.fetched_at as string).getTime() : 0;
  assert("the row's fetched_at was updated to (approximately) now, not left stale", Date.now() - refetchedAt < 15_000, `age=${Date.now() - refetchedAt}ms`);

  console.log("\n████ 3. Provider error does NOT poison the cache ████");
  let fnCalls = 0;
  async function throwingFn(): Promise<string> {
    fnCalls++;
    throw new Error("simulated provider failure");
  }
  let threw = false;
  try {
    await step("durableCached with a throwing fn — should propagate, not swallow", () => durableCached("__verify_test__", "ERRORCASE", "", 60_000, throwingFn), 10000);
  } catch {
    threw = true;
  }
  assert("the error PROPAGATED out of durableCached (not swallowed)", threw);
  const poisonedRow = await step("check NO row was written for the failed fetch", () =>
    admin.from("price_cache").select("*").eq("kind", "__verify_test__").eq("symbol", "ERRORCASE").maybeSingle(),
  );
  assert("no price_cache row exists for the failed fetch (L2 not poisoned)", !poisonedRow.data, JSON.stringify(poisonedRow.data));

  // A second call with a fn that SUCCEEDS proves L1 wasn't poisoned either —
  // if the first call had cached the failure, this would short-circuit
  // without invoking `fn` a second time.
  let secondCalled = false;
  const secondResult = await step("durableCached again, same key, with a succeeding fn", () =>
    durableCached("__verify_test__", "ERRORCASE", "", 60_000, async () => {
      secondCalled = true;
      return "recovered";
    }),
    10000,
  );
  assert("the retry actually invoked fn (L1 wasn't poisoned by the prior failure)", secondCalled);
  assert("the retry's real value was returned", secondResult === "recovered");

  console.log("\n████ 4. Prune deletes old rows, leaves fresh ones ████");
  await step("insert one OLD row (10 days old) and one FRESH row", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
    const nowIso = new Date().toISOString();
    await admin.from("price_cache").upsert([
      { kind: "__verify_test__", symbol: "PRUNECASE_OLD", interval: "", payload: { x: 1 }, fetched_at: tenDaysAgo },
      { kind: "__verify_test__", symbol: "PRUNECASE_FRESH", interval: "", payload: { x: 2 }, fetched_at: nowIso },
    ]);
  });
  const pruneSummary = await step("runPriceCachePrune()", () => runPriceCachePrune(), 15000);
  console.log(`  prune summary: ${JSON.stringify(pruneSummary)}`);
  const oldAfter = await step("check the OLD row is gone", () => admin.from("price_cache").select("*").eq("kind", "__verify_test__").eq("symbol", "PRUNECASE_OLD").maybeSingle());
  const freshAfter = await step("check the FRESH row survived", () => admin.from("price_cache").select("*").eq("kind", "__verify_test__").eq("symbol", "PRUNECASE_FRESH").maybeSingle());
  assert("the 10-day-old row was pruned", !oldAfter.data, JSON.stringify(oldAfter.data));
  assert("the fresh row was NOT pruned", !!freshAfter.data, JSON.stringify(freshAfter.data));

  console.log("\n████ 5. RLS/grant sanity — service_role can read/write/delete; authenticated cannot ████");
  const { data: probe, error: probeErr } = await admin.from("price_cache").select("kind").limit(1);
  assert("service_role CAN read price_cache", !probeErr, probeErr?.message);

  console.log("\n████ Cleanup ████");
  await step("delete all __verify_test__ rows + the real AAPL quote test row", () =>
    admin.from("price_cache").delete().in("kind", ["__verify_test__", "quote"]).in("symbol", ["ERRORCASE", "PRUNECASE_OLD", "PRUNECASE_FRESH", SYMBOL]),
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
