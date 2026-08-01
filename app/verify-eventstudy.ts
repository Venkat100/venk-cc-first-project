// Throwaway unit test for the EVENT STUDY pure math (run with vite-node — no
// network, no DB, no Claude — this is pure arithmetic over a synthetic candle
// series constructed so every answer is known BY CONSTRUCTION).
//
// Strategy: build a "quiet" baseline of alternating ±3% daily returns (a
// large-but-consistent volatility so a stable trailing sigma is well
// established), then splice in 3 down-shock days (-20%, unambiguously > 2σ of
// the ±3% baseline) each followed by a SMOOTH (small, sub-threshold, so it
// never registers as its own shock) compounding path that lands EXACTLY on a
// chosen forward-return target at +5 and +21 trading days — so those forward
// returns are exact by construction, not estimated. Each event gets a 70-day
// quiet buffer (> TRAILING_WINDOW_DAYS=60) before the next, so trailing
// windows never mix across events.
//
// Two independent checks, deliberately NOT reusing the module's internals:
//   1. A separately-written reference shock-detector (own mean/stdev) must
//      flag exactly the 3 planted days and nothing else.
//   2. The forward-return stats are hand-computed from the planted numbers
//      and compared to the module's output.
import { findShockEvents, computeEventStudy, TRAILING_WINDOW_DAYS, SHOCK_STDEV_MULT, MIN_TRAILING_SAMPLE } from "@/lib/insights/eventstudy.server";
import type { Candle } from "@/lib/marketData/types";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// ─── Build the synthetic series ────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const dateAt = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * DAY_MS).toISOString();

function altPath(startPrice: number, n: number, mag = 0.03): number[] {
  const out: number[] = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    p = p * (1 + (i % 2 === 0 ? mag : -mag));
    out.push(p);
  }
  return out;
}

function smoothPath(startPrice: number, targetPrice: number, n: number): number[] {
  const factor = Math.pow(targetPrice / startPrice, 1 / n);
  const out: number[] = [];
  let p = startPrice;
  for (let i = 0; i < n; i++) {
    p = p * factor;
    out.push(p);
  }
  out[out.length - 1] = targetPrice; // force the exact endpoint (kill float drift)
  return out;
}

const closes: number[] = [100]; // day 0
const push = (xs: number[]) => closes.push(...xs);

// 89 quiet days so the first event has a full 60-return trailing window.
push(altPath(closes.at(-1)!, 89));

type PlantedEvent = { day: number; fwd1w: number; fwd1m: number };
const planted: PlantedEvent[] = [];

function plantDownShock(fwd1w: number, fwd1m: number, quietBufferAfter: number) {
  const day = closes.length; // index this shock will land on
  const preClose = closes.at(-1)!;
  const shockClose = preClose * 0.8; // -20%
  closes.push(shockClose);
  const target1w = shockClose * (1 + fwd1w);
  push(smoothPath(shockClose, target1w, 5)); // days day+1..day+5, closes[day+5]=target1w exactly
  const target1m = shockClose * (1 + fwd1m);
  push(smoothPath(closes.at(-1)!, target1m, 16)); // days day+6..day+21, closes[day+21]=target1m exactly
  planted.push({ day, fwd1w, fwd1m });
  push(altPath(closes.at(-1)!, quietBufferAfter)); // buffer > TRAILING_WINDOW_DAYS before the next event
}

plantDownShock(0.05, 0.1, 70); // Event A
plantDownShock(-0.03, 0.02, 70); // Event B
plantDownShock(0.01, -0.08, 10); // Event C (short tail buffer — no event after it)

const candles: Candle[] = closes.map((close, i) => ({ t: dateAt(i), open: close, high: close, low: close, close, volume: 0 }));

console.log(`\n████ Synthetic series: ${candles.length} candles, ${planted.length} planted down-shocks at days [${planted.map((p) => p.day).join(", ")}] ████`);

// ─── Check 1: independent reference detector agrees on WHICH days shocked ──

function refMean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function refStdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = refMean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const refReturns: number[] = [];
for (let i = 1; i < closes.length; i++) refReturns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
const refShockDays: number[] = [];
for (let day = 1; day < closes.length; day++) {
  const retIdx = day - 1;
  if (retIdx < MIN_TRAILING_SAMPLE) continue;
  const trailStart = Math.max(0, retIdx - TRAILING_WINDOW_DAYS);
  const trailing = refReturns.slice(trailStart, retIdx);
  if (trailing.length < MIN_TRAILING_SAMPLE) continue;
  const sigma = refStdev(trailing);
  if (sigma <= 0) continue;
  const r = refReturns[retIdx];
  if (Math.abs(r) > SHOCK_STDEV_MULT * sigma && day + 21 < closes.length) refShockDays.push(day);
}
console.log(`  independent reference detector flagged days: [${refShockDays.join(", ")}]`);

const moduleEvents = findShockEvents(closes);
const moduleShockDays = moduleEvents.map((e) => e.dayIndex);
console.log(`  module findShockEvents flagged days:          [${moduleShockDays.join(", ")}]`);

assert("independent reference detector flags EXACTLY the 3 planted days, nothing else", JSON.stringify(refShockDays) === JSON.stringify(planted.map((p) => p.day)), refShockDays.join(","));
assert("module findShockEvents matches the independent reference EXACTLY", JSON.stringify(moduleShockDays) === JSON.stringify(refShockDays), moduleShockDays.join(","));

for (const p of planted) {
  const ev = moduleEvents.find((e) => e.dayIndex === p.day);
  assert(`event@day${p.day}: module fwd1w matches planted EXACTLY`, !!ev && approx(ev.fwd1w, p.fwd1w), `${ev?.fwd1w} vs ${p.fwd1w}`);
  assert(`event@day${p.day}: module fwd1m matches planted EXACTLY`, !!ev && approx(ev.fwd1m, p.fwd1m), `${ev?.fwd1m} vs ${p.fwd1m}`);
}

// ─── Check 2: aggregate stats match hand-computed values from the planted numbers ──

const study = computeEventStudy(candles);
console.log("\n  down:", JSON.stringify(study.down, null, 2));
console.log("  up:  ", JSON.stringify(study.up, null, 2));

// Hand math (down direction, 3 planted events: fwd1w = [.05,-.03,.01], fwd1m = [.10,.02,-.08]):
const handAvg1w = (0.05 + -0.03 + 0.01) / 3; // 0.01
const handMedian1w = 0.01; // sorted [-.03,.01,.05] -> middle = .01
const handAvg1m = (0.1 + 0.02 + -0.08) / 3; // 0.013333...
const handMedian1m = 0.02; // sorted [-.08,.02,.10] -> middle = .02
const handWorst1m = -0.08;
const handBest1m = 0.1;
const handPctPos1m = 2 / 3; // .10 and .02 positive, -.08 negative

assert("down.events_found === 3", study.down.events_found === 3, `${study.down.events_found}`);
assert("down.avg_fwd_1w matches hand calc", approx(study.down.avg_fwd_1w!, handAvg1w, 1e-4), `${study.down.avg_fwd_1w} vs ${handAvg1w}`);
assert("down.median_fwd_1w matches hand calc", approx(study.down.median_fwd_1w!, handMedian1w, 1e-4), `${study.down.median_fwd_1w} vs ${handMedian1w}`);
assert("down.avg_fwd_1m matches hand calc", approx(study.down.avg_fwd_1m!, handAvg1m, 1e-4), `${study.down.avg_fwd_1m} vs ${handAvg1m}`);
assert("down.median_fwd_1m matches hand calc", approx(study.down.median_fwd_1m!, handMedian1m, 1e-4), `${study.down.median_fwd_1m} vs ${handMedian1m}`);
assert("down.worst_1m matches hand calc", approx(study.down.worst_1m!, handWorst1m, 1e-4), `${study.down.worst_1m} vs ${handWorst1m}`);
assert("down.best_1m matches hand calc", approx(study.down.best_1m!, handBest1m, 1e-4), `${study.down.best_1m} vs ${handBest1m}`);
assert("down.pct_positive_1m matches hand calc", approx(study.down.pct_positive_1m!, handPctPos1m, 1e-4), `${study.down.pct_positive_1m} vs ${handPctPos1m}`);
assert("down.direction === 'down'", study.down.direction === "down");
assert("down.window_years is plausible (~0.8-0.9y for ~305 days)", study.down.window_years > 0.7 && study.down.window_years < 1.0, `${study.down.window_years}`);

// Only DOWN shocks were planted — the UP side must honestly report zero, not fabricate.
assert("up.events_found === 0 (no up-shocks planted)", study.up.events_found === 0, `${study.up.events_found}`);
assert("up.avg_fwd_1w is null (honest degrade, not 0 or NaN)", study.up.avg_fwd_1w === null);
assert("up.median_fwd_1m is null", study.up.median_fwd_1m === null);
assert("up.pct_positive_1m is null", study.up.pct_positive_1m === null);

// ─── Check 3: short-history series degrades honestly (no NaN/crash) ───────

console.log("\n████ Short-history (recent-IPO-like) synthetic series ████");
const shortCloses = altPath(50, 15); // only 15 days — below MIN_TRAILING_SAMPLE(20)
const shortCandles: Candle[] = [100, ...shortCloses].map((close, i) => ({ t: dateAt(i), open: close, high: close, low: close, close, volume: 0 }));
const shortStudy = computeEventStudy(shortCandles);
assert("short history: down.events_found === 0", shortStudy.down.events_found === 0, `${shortStudy.down.events_found}`);
assert("short history: up.events_found === 0", shortStudy.up.events_found === 0, `${shortStudy.up.events_found}`);
assert("short history: no NaN anywhere in down stats", Object.values(shortStudy.down).every((v) => v === null || typeof v === "string" || (typeof v === "number" && !Number.isNaN(v))));
assert("short history: no NaN anywhere in up stats", Object.values(shortStudy.up).every((v) => v === null || typeof v === "string" || (typeof v === "number" && !Number.isNaN(v))));

// Empty series — must not crash.
const empty = computeEventStudy([]);
assert("empty series: no crash, events_found === 0", empty.down.events_found === 0 && empty.up.events_found === 0);

console.log(`\n${failures === 0 ? "ALL EVENT-STUDY UNIT CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
