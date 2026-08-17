// Stock page enrichment, phase 2 (2026-08-14) — real Finnhub calls, zero
// mocks. Proves: (1) each of the 4 new datasets returns real, correctly-
// shaped data for a mega-cap; (2) an ETF genuinely returns empty for all
// four (not an error); (3) the durableCached L1 layer actually prevents a
// second Finnhub round trip for the same symbol within the 24h TTL — the
// exact claim "repeat page loads must not re-fetch" needs proof for, not
// just an assumption from reading the code.
import { fhStockEnrichment } from "@/lib/marketData/finnhub.server";
import { fetchStats, resetFetchStats } from "@/lib/marketData/finnhub.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { __clearL1ForTest } from "@/lib/marketData/cache.server";
import { step, assert, runVerification, withRetry } from "./verify-harness";

const admin = getServiceClient();
const ENRICHMENT_KINDS = ["nextEarnings", "earningsSurprises", "recommendationTrend", "peers"] as const;

async function main() {
  console.log("\n████ 1. Mega-cap (AAPL) — all 4 datasets real and correctly shaped ████");
  const aapl = await step("fhStockEnrichment(AAPL)", () => withRetry("fhStockEnrichment(AAPL)", () => fhStockEnrichment("AAPL")));
  console.log(`  nextEarnings: ${JSON.stringify(aapl.nextEarnings)}`);
  console.log(`  earningsSurprises: ${aapl.earningsSurprises.length} rows`);
  console.log(`  recommendationTrend: ${aapl.recommendationTrend.length} rows`);
  console.log(`  peers: ${aapl.peers.join(", ")}`);
  assert("nextEarnings has a real future-or-today date", !!aapl.nextEarnings?.date && aapl.nextEarnings.date >= new Date().toISOString().slice(0, 10), aapl.nextEarnings?.date);
  assert("earningsSurprises has up to 4 rows, each with a real actual EPS", aapl.earningsSurprises.length > 0 && aapl.earningsSurprises.every((s) => s.actual != null), `${aapl.earningsSurprises.length} rows`);
  assert("earningsSurprises sorted newest-first", aapl.earningsSurprises.every((s, i) => i === 0 || s.period <= aapl.earningsSurprises[i - 1].period));
  assert("recommendationTrend has real analyst counts summing > 0", aapl.recommendationTrend.length > 0 && aapl.recommendationTrend[0].strongBuy + aapl.recommendationTrend[0].buy + aapl.recommendationTrend[0].hold + aapl.recommendationTrend[0].sell + aapl.recommendationTrend[0].strongSell > 0, JSON.stringify(aapl.recommendationTrend[0]));
  assert("peers is non-empty and excludes AAPL itself", aapl.peers.length > 0 && !aapl.peers.includes("AAPL"), aapl.peers.join(","));

  console.log("\n████ 2. ETF (VOO) — genuinely empty for all 4, not an error ████");
  const voo = await step("fhStockEnrichment(VOO)", () => withRetry("fhStockEnrichment(VOO)", () => fhStockEnrichment("VOO")));
  console.log(`  nextEarnings=${JSON.stringify(voo.nextEarnings)} surprises=${voo.earningsSurprises.length} trend=${voo.recommendationTrend.length} peers=${voo.peers.length}`);
  assert("VOO nextEarnings is absent (undefined, not a thrown error)", voo.nextEarnings === undefined);
  assert("VOO earningsSurprises is an empty array", voo.earningsSurprises.length === 0);
  assert("VOO recommendationTrend is an empty array", voo.recommendationTrend.length === 0);
  assert("VOO peers is an empty array", voo.peers.length === 0);

  console.log("\n████ 3. Mid-cap (SOFI) — real data, independent of AAPL/VOO ████");
  const sofi = await step("fhStockEnrichment(SOFI)", () => withRetry("fhStockEnrichment(SOFI)", () => fhStockEnrichment("SOFI")));
  assert("SOFI has a real next-earnings date, different symbol context from AAPL", !!sofi.nextEarnings?.date);
  assert("SOFI peers is non-empty and excludes SOFI itself", sofi.peers.length > 0 && !sofi.peers.includes("SOFI"), sofi.peers.join(","));

  console.log("\n████ 4. Cache proof: a SECOND call for a FRESH symbol makes ZERO additional Finnhub requests ████");
  // MUST be genuinely cold on every run of this script, not just the first
  // time it's ever executed — a hardcoded symbol re-run within the same
  // 24h ENRICHMENT_TTL would silently hit an already-warm L2 row from a
  // PRIOR run and fail the "1st call fetches" assertion, the exact
  // non-idempotent-test flakiness class already root-caused and fixed
  // elsewhere in this suite (see verify-hardening-pass.ts's HANDOFF entry).
  // Explicit clean slate first — same pattern verify-live-prices.ts uses.
  const freshSymbol = "CRM";
  console.log("\n  clean slate: clear L1 + delete this symbol's price_cache rows for all 4 kinds");
  __clearL1ForTest();
  await admin.from("price_cache").delete().eq("symbol", freshSymbol).in("kind", ENRICHMENT_KINDS);
  resetFetchStats();
  const before = fetchStats();
  await step(`fhStockEnrichment(${freshSymbol}) — 1st call, cold`, () => fhStockEnrichment(freshSymbol));
  const afterFirst = fetchStats();
  const firstCallFetches = afterFirst.total - before.total;
  console.log(`  1st call: ${firstCallFetches} real Finnhub requests (expect 4 — one per endpoint, all cold)`);
  assert("1st call made exactly 4 real network requests — one per endpoint, all cold (not a false positive from an already-warm row)", firstCallFetches === 4, String(firstCallFetches));

  await step(`fhStockEnrichment(${freshSymbol}) — 2nd call, should be a pure L1 cache hit`, () => fhStockEnrichment(freshSymbol));
  const afterSecond = fetchStats();
  const secondCallFetches = afterSecond.total - afterFirst.total;
  console.log(`  2nd call (same process, same symbol): ${secondCallFetches} additional Finnhub requests (expect 0)`);
  assert("2nd call made ZERO additional Finnhub requests — durableCached's L1 layer is doing its job", secondCallFetches === 0, String(secondCallFetches));

  await step("cleanup: delete this run's test price_cache rows (keep the suite idempotent for the NEXT run too)", () =>
    admin.from("price_cache").delete().eq("symbol", freshSymbol).in("kind", ENRICHMENT_KINDS),
  );

  console.log("\n████ 5. Rate-limit arithmetic (reported, not asserted — see script header) ████");
  console.log("  Each of the 4 new endpoints is cached 24h per symbol (ENRICHMENT_TTL in finnhub.server.ts).");
  console.log("  Steady state: cost is per DISTINCT symbol viewed per DAY, not per page view — every viewer of an");
  console.log("  already-warm symbol within 24h is a cache hit (L1 in-process, L2 durable Postgres survives cold starts).");
  console.log("  Worst case for a burst of N never-before-seen symbols in one minute: 4×N Finnhub calls, sharing the");
  console.log("  SAME module-level RateLimiter(50,6) every other Finnhub call already goes through — self-throttled,");
  console.log("  not a new risk. At this app's real scale (a handful of real accounts, confirmed via the admin console's");
  console.log("  test-account audit), even an implausible 15 brand-new symbols/minute = 60 calls/min, still inside the cap.");
}

runVerification(main);
