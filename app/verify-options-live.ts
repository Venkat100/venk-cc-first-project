// Real E2E for the options pricing engine (run with vite-node). REAL Twelve
// Data + Finnhub calls, no mocks. Covers: realized vol for a volatile name
// vs. a calm one, a real generated NVDA chain with monotonicity/expiry/ATM
// assertions, and day-cache sharing with the AI Insights event study via the
// shared getDailyHistory cache.
import { getRealizedVol, MIN_VOL, MAX_VOL } from "@/lib/options/volatility.server";
import { buildChain } from "@/lib/options/chain.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import { getDailyHistory } from "@/lib/marketData/dailyHistory.server";
import { withRetry } from "./verify-harness";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

console.log("\n████ 1. Realized volatility — volatile (NVDA) vs. calm (KO) ████");
const [volNvda, volKo] = await Promise.all([getRealizedVol("NVDA"), getRealizedVol("KO")]);
console.log(`  NVDA annualized realized vol: ${(volNvda * 100).toFixed(1)}%`);
console.log(`  KO   annualized realized vol: ${(volKo * 100).toFixed(1)}%`);
assert("both within the clamp band [10%, 150%]", volNvda >= MIN_VOL && volNvda <= MAX_VOL && volKo >= MIN_VOL && volKo <= MAX_VOL);
assert("NVDA (volatile) has MEANINGFULLY higher realized vol than KO (calm)", volNvda > volKo * 1.2, `NVDA=${(volNvda * 100).toFixed(1)}% KO=${(volKo * 100).toFixed(1)}%`);
console.log("  (clamp math itself — flooring a flat series to 10%, ceiling an extreme series to 150% — was unit-tested against synthetic series in verify-options-chain.ts §5; real market data essentially never hits either bound, which is exactly what we see here.)");

console.log("\n████ 2. Day-cache sharing: getDailyHistory reused between insights + options ████");
const t0 = Date.now();
const h1 = await getDailyHistory("NVDA");
const midMs = Date.now() - t0;
const t1 = Date.now();
const h2 = await getDailyHistory("NVDA");
const secondMs = Date.now() - t1;
assert("second call returns the identical array length (served from cache)", h1.length === h2.length, `${h1.length} vs ${h2.length}`);
assert("second call is dramatically faster (cache hit, no network)", secondMs < Math.max(5, midMs / 3), `first=${midMs}ms second=${secondMs}ms`);

console.log("\n████ 3. Real generated NVDA chain ████");
const [nvdaQuote] = await withRetry("NVDA quote", () => providerQuotes(["NVDA"]));
console.log(`  NVDA live spot: $${nvdaQuote.price}`);
const chain = buildChain({ symbol: "NVDA", spot: nvdaQuote.price, vol: volNvda });
assert("chain has ≥5 expiries", chain.expiries.length >= 5, `${chain.expiries.length}`);
assert("every expiry date is a real Friday", chain.expiries.every((e) => new Date(e.expiry + "T00:00:00Z").getUTCDay() === 5), chain.expiries.map((e) => e.expiry).join(","));
assert("expiries sorted ascending", chain.expiries.every((e, i) => i === 0 || e.expiry > chain.expiries[i - 1].expiry));

let monotonicityHolds = true;
let reconciliationHolds = true;
for (const exp of chain.expiries) {
  const calls = exp.strikes.map((r) => r.call.premium);
  const puts = exp.strikes.map((r) => r.put.premium);
  if (!calls.every((p, i) => i === 0 || p <= calls[i - 1] + 1e-9)) monotonicityHolds = false;
  if (!puts.every((p, i) => i === 0 || p >= puts[i - 1] - 1e-9)) monotonicityHolds = false;
  for (const r of exp.strikes) {
    if (Math.abs(r.call.intrinsic + r.call.extrinsic - r.call.premium) > 0.005) reconciliationHolds = false;
    if (Math.abs(r.put.intrinsic + r.put.extrinsic - r.put.premium) > 0.005) reconciliationHolds = false;
  }
}
assert("call premiums DECREASE and put premiums INCREASE across strikes, EVERY expiry", monotonicityHolds);
assert("intrinsic + extrinsic reconciles to premium, EVERY contract", reconciliationHolds);

const nearest = chain.expiries[0];
console.log(`\n  Nearest expiry ${nearest.expiry} (${nearest.daysToExpiry}d to expiry), vol=${(volNvda * 100).toFixed(1)}%, spot=$${nvdaQuote.price}:`);
console.log(`  ${"STRIKE".padEnd(8)}${"CALL $".padEnd(9)}${"CALL Δ".padEnd(9)}${"PUT $".padEnd(9)}${"PUT Δ".padEnd(9)}${"CALL EXTR.".padEnd(11)}CONTRACT ID`);
for (const r of nearest.strikes) {
  console.log(`  ${String(r.strike).padEnd(8)}${String(r.call.premium).padEnd(9)}${r.call.delta.toFixed(3).padEnd(9)}${String(r.put.premium).padEnd(9)}${r.put.delta.toFixed(3).padEnd(9)}${String(r.call.extrinsic).padEnd(11)}${r.call.contractId}`);
}

let atmIdx = 0;
for (let i = 1; i < nearest.strikes.length; i++) {
  if (Math.abs(nearest.strikes[i].strike - nvdaQuote.price) < Math.abs(nearest.strikes[atmIdx].strike - nvdaQuote.price)) atmIdx = i;
}
const atmExtr = nearest.strikes[atmIdx].call.extrinsic;
const maxExtr = Math.max(...nearest.strikes.map((r) => r.call.extrinsic));
assert("ATM strike has the (or ties for) largest call extrinsic value in the nearest expiry", Math.abs(atmExtr - maxExtr) < 0.05, `atm=${atmExtr} max=${maxExtr}`);
// Closed interval, not open: at the nearest (often 1-day) expiry, deep
// OTM/ITM strikes push d1 far enough that the normal CDF genuinely
// saturates to exactly 0.0 or 1.0 in float64 — a real, mathematically
// correct limit of N(d1) as |d1| grows, not a bug in blackscholes.ts. An
// open-interval assertion here was failing deterministically against
// today's real NVDA chain (2026-08-13 app audit, issue #19) for exactly
// this reason; the premiums themselves reconcile correctly regardless.
assert("all deltas well-formed: calls in [0,1], puts in [-1,0]", nearest.strikes.every((r) => r.call.delta >= 0 && r.call.delta <= 1 && r.put.delta >= -1 && r.put.delta <= 0));

console.log(`\n${failures === 0 ? "ALL OPTIONS LIVE CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
