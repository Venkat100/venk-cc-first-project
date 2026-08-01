// Unit tests for chain generation (run with vite-node — no network). Pins an
// explicit `asOf` date so expiry generation is fully deterministic, then
// checks structural properties of a chain built from a FABRICATED spot/vol
// (no live fetch — this file tests chain.server.ts's pure logic only).
import { generateExpiries, thirdFriday, generateStrikes, strikeStep, buildChain } from "@/lib/options/chain.server";
import { computeRealizedVol } from "@/lib/options/volatility.server";
import type { Candle } from "@/lib/marketData/types";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

// ─── 1. Expiry generation ──────────────────────────────────────────────────
console.log("\n████ 1. Expiry generation (pinned asOf = 2026-08-01, a Saturday) ████");
{
  const asOf = new Date(Date.UTC(2026, 7, 1)); // Aug 1 2026 — a Saturday
  const expiries = generateExpiries(asOf);
  const isoList = expiries.map((d) => d.toISOString().slice(0, 10));
  console.log(`  expiries: ${isoList.join(", ")}`);

  assert("all expiries are Fridays", expiries.every((d) => d.getUTCDay() === 5), isoList.join(","));
  assert("all expiries are on/after asOf", expiries.every((d) => d.getTime() >= asOf.getTime()));
  assert("expiries sorted ascending", isoList.every((v, i) => i === 0 || v > isoList[i - 1]));
  assert("at least 5 expiries generated (4 monthly + ≥1 weekly, minus any dedup)", expiries.length >= 5, `${expiries.length}`);
  assert("no duplicate dates", new Set(isoList).size === isoList.length);

  // Independent cross-check: brute-force day-by-day scan for "3rd Friday",
  // a different algorithm than the module's closed-form calculation.
  function refThirdFriday(year: number, monthIndex0: number): string {
    let fridayCount = 0;
    for (let day = 1; day <= 28; day++) {
      const d = new Date(Date.UTC(year, monthIndex0, day));
      if (d.getUTCDay() === 5) {
        fridayCount++;
        if (fridayCount === 3) return d.toISOString().slice(0, 10);
      }
    }
    throw new Error("no 3rd Friday found in first 28 days — shouldn't happen");
  }
  for (const [y, m] of [
    [2026, 7],
    [2026, 8],
    [2026, 9],
    [2026, 10],
    [2026, 11],
  ]) {
    const ref = refThirdFriday(y, m - 1);
    const got = thirdFriday(y, m - 1).toISOString().slice(0, 10);
    assert(`3rd Friday of ${y}-${String(m).padStart(2, "0")}: module=${got} vs independent brute-force=${ref}`, got === ref);
  }
  assert("generated chain includes the independently-computed Aug 2026 3rd Friday", isoList.includes(refThirdFriday(2026, 7)));
  assert("generated chain includes the independently-computed Sep 2026 3rd Friday", isoList.includes(refThirdFriday(2026, 8)));
}

// ─── 2. Strike generation ──────────────────────────────────────────────────
console.log("\n████ 2. Strike ladder by price magnitude ████");
{
  assert("spot < $25 → $1 step", strikeStep(18) === 1);
  assert("$25 ≤ spot < $100 → $2.50 step", strikeStep(60) === 2.5);
  assert("$100 ≤ spot < $250 → $5 step", strikeStep(180) === 5);
  assert("spot ≥ $250 → $10 step", strikeStep(500) === 10);

  const strikes = generateStrikes(187.32);
  console.log(`  strikes around $187.32: ${strikes.join(", ")}`);
  assert("strike count within the requested 8-12 band", strikes.length >= 8 && strikes.length <= 12, `${strikes.length}`);
  assert("strikes are strictly increasing, evenly spaced by the $5 step", strikes.every((s, i) => i === 0 || Math.abs(s - strikes[i - 1] - 5) < 1e-9));
  assert("center strike is within half a step of spot", Math.min(...strikes.map((s) => Math.abs(s - 187.32))) <= 2.5);
  assert("all strikes are clean 2dp numbers (no float noise)", strikes.every((s) => Math.abs(s * 100 - Math.round(s * 100)) < 1e-6));
}

// ─── 3. Full chain: monotonicity + ATM extrinsic + contract IDs ───────────
console.log("\n████ 3. Full generated chain (fabricated NVDA-like inputs: spot=$200, vol=45%) ████");
{
  const asOf = new Date(Date.UTC(2026, 7, 1));
  const chain = buildChain({ symbol: "NVDA", spot: 200, vol: 0.45, asOf });
  assert("chain has multiple expiries", chain.expiries.length >= 5, `${chain.expiries.length}`);

  for (const exp of chain.expiries) {
    const calls = exp.strikes.map((r) => r.call.premium);
    const puts = exp.strikes.map((r) => r.put.premium);
    const strikesAsc = exp.strikes.every((r, i) => i === 0 || r.strike > exp.strikes[i - 1].strike);
    assert(`[${exp.expiry}] strikes ascending`, strikesAsc);
    const callsMonotoneDown = calls.every((p, i) => i === 0 || p <= calls[i - 1] + 1e-9);
    const putsMonotoneUp = puts.every((p, i) => i === 0 || p >= puts[i - 1] - 1e-9);
    assert(`[${exp.expiry}] call premiums DECREASE as strike rises`, callsMonotoneDown, calls.map((c) => c.toFixed(2)).join(","));
    assert(`[${exp.expiry}] put premiums INCREASE as strike rises`, putsMonotoneUp, puts.map((c) => c.toFixed(2)).join(","));

    // ATM (closest-to-spot strike) should have the largest extrinsic value of the row.
    let atmIdx = 0;
    for (let i = 1; i < exp.strikes.length; i++) {
      if (Math.abs(exp.strikes[i].strike - 200) < Math.abs(exp.strikes[atmIdx].strike - 200)) atmIdx = i;
    }
    const atmCallExtrinsic = exp.strikes[atmIdx].call.extrinsic;
    const maxExtrinsic = Math.max(...exp.strikes.map((r) => r.call.extrinsic));
    if (exp.daysToExpiry > 0) {
      assert(`[${exp.expiry}] ATM call extrinsic is the (or tied for) largest in the row`, Math.abs(atmCallExtrinsic - maxExtrinsic) < 0.02, `atm=${atmCallExtrinsic} max=${maxExtrinsic}`);
    }

    // contract id shape + intrinsic/extrinsic reconciliation
    const row0 = exp.strikes[0];
    assert(`[${exp.expiry}] contractId format`, row0.call.contractId === `NVDA-${exp.expiry}-C-${row0.strike}`, row0.call.contractId);
    for (const r of exp.strikes) {
      assert(`[${exp.expiry}] K=${r.strike} call intrinsic+extrinsic reconciles to premium`, Math.abs(r.call.intrinsic + r.call.extrinsic - r.call.premium) < 0.005);
      assert(`[${exp.expiry}] K=${r.strike} put intrinsic+extrinsic reconciles to premium`, Math.abs(r.put.intrinsic + r.put.extrinsic - r.put.premium) < 0.005);
    }
  }

  const nearest = chain.expiries[0];
  console.log(`  nearest expiry ${nearest.expiry} (${nearest.daysToExpiry}d): ` + nearest.strikes.map((r) => `K${r.strike}: C$${r.call.premium}/P$${r.put.premium}`).join("  "));
}

// ─── 4. Expiry-day chain (T=0) — contracts must be exact intrinsic ─────────
console.log("\n████ 4. Chain built ON an expiry date itself (T=0 contracts = exact intrinsic) ████");
{
  const expiryDay = thirdFriday(2026, 7); // Aug 21 2026
  const chain = buildChain({ symbol: "NVDA", spot: 200, vol: 0.45, asOf: expiryDay });
  const todaysExpiry = chain.expiries.find((e) => e.expiry === expiryDay.toISOString().slice(0, 10));
  assert("today's own 3rd-Friday expiry is included with daysToExpiry=0", !!todaysExpiry && todaysExpiry.daysToExpiry === 0, `${todaysExpiry?.daysToExpiry}`);
  if (todaysExpiry) {
    for (const r of todaysExpiry.strikes) {
      const expectedCall = Math.max(200 - r.strike, 0);
      const expectedPut = Math.max(r.strike - 200, 0);
      assert(`K=${r.strike} T=0 call === exact intrinsic`, r.call.premium === Math.round(expectedCall * 100) / 100, `${r.call.premium} vs ${expectedCall}`);
      assert(`K=${r.strike} T=0 put === exact intrinsic`, r.put.premium === Math.round(expectedPut * 100) / 100, `${r.put.premium} vs ${expectedPut}`);
    }
  }
}

// ─── 5. Realized-vol synthetic sanity (independent of live data) ──────────
console.log("\n████ 5. Realized vol on a synthetic KNOWN-stdev series ████");
{
  // Construct a series with a known constant daily log-return magnitude:
  // alternating +1%/-1% log returns ⇒ population-like stdev ≈ 0.01 * sqrt(n/(n-1)).
  const closes: number[] = [100];
  for (let i = 0; i < 120; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
  const candles: Candle[] = closes.map((close, i) => ({ t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), open: close, high: close, low: close, close, volume: 0 }));
  const vol = computeRealizedVol(candles, 60);
  const expectedDailySigma = 0.01 * Math.sqrt(60 / 59);
  const expectedAnnual = expectedDailySigma * Math.sqrt(252);
  console.log(`  computed=${(vol * 100).toFixed(2)}%  independently-expected=${(expectedAnnual * 100).toFixed(2)}%`);
  assert("realized vol matches independent hand calc (within clamp band)", Math.abs(vol - Math.min(1.5, Math.max(0.1, expectedAnnual))) < 0.001, `${vol} vs ${expectedAnnual}`);

  const flat: Candle[] = Array.from({ length: 100 }, (_, i) => ({ t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), open: 50, high: 50, low: 50, close: 50, volume: 0 }));
  assert("zero-movement series clamps to MIN_VOL floor (10%)", computeRealizedVol(flat) === 0.1, `${computeRealizedVol(flat)}`);

  const wild: Candle[] = [100];
  for (let i = 0; i < 80; i++) wild.push(wild[wild.length - 1] * (i % 2 === 0 ? 1.5 : 1 / 1.5));
  const wildCandles: Candle[] = wild.map((close, i) => ({ t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), open: close, high: close, low: close, close, volume: 0 }));
  assert("extreme-swing series clamps to MAX_VOL ceiling (150%)", computeRealizedVol(wildCandles) === 1.5, `${computeRealizedVol(wildCandles)}`);

  assert("short/empty series falls back to MIN_VOL, no NaN/crash", computeRealizedVol([]) === 0.1 && computeRealizedVol([{ t: "x", open: 1, high: 1, low: 1, close: 1, volume: 0 }]) === 0.1);
}

console.log(`\n${failures === 0 ? "ALL OPTIONS-CHAIN UNIT CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
