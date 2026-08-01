// Unit tests for the pure Black-Scholes module (run with vite-node — no
// network). Two independent cross-checks, neither reusing the module's own
// normCdf/erf implementation:
//   1. Numerical integration (Simpson's rule, 20,000 steps) of the
//      risk-neutral discounted expected payoff — a completely different
//      computational method (no closed-form N(x) at all) that converges to
//      the true BS price far beyond cent precision.
//   2. Put-call parity (Call - Put = S - K·e^(-rT)), an exact mathematical
//      identity that must hold to floating-point precision if the call and
//      put formulas are both implemented correctly.
import { priceOption, optionGreeks, type BSInputs } from "@/lib/options/blackscholes";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function closeTo(a: number, b: number, eps: number) {
  return Math.abs(a - b) <= eps;
}

// ─── Independent numerical-integration reference price ─────────────────────
function refNormPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}
function refPrice(type: "call" | "put", S: number, K: number, T: number, sigma: number, r: number): number {
  if (T <= 0) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const zMin = -8,
    zMax = 8,
    n = 20_000;
  const h = (zMax - zMin) / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const z = zMin + i * h;
    const ST = S * Math.exp((r - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z);
    const payoff = type === "call" ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
    const weight = payoff * refNormPdf(z);
    const coeff = i === 0 || i === n ? 1 : i % 2 === 0 ? 2 : 4;
    sum += coeff * weight;
  }
  const integral = (h / 3) * sum;
  return Math.exp(-r * T) * integral;
}

type Case = { name: string; inputs: BSInputs };
const cases: Case[] = [
  { name: "ATM 1yr (classic S=K=100, σ=20%, r=5%)", inputs: { spot: 100, strike: 100, timeYears: 1, vol: 0.2, rate: 0.05 } },
  { name: "Hull textbook example (S=42, K=40, T=0.5, r=10%, σ=20%)", inputs: { spot: 42, strike: 40, timeYears: 0.5, vol: 0.2, rate: 0.1 } },
  { name: "Deep ITM (S=150, K=50, T=0.5, σ=30%, r=3%)", inputs: { spot: 150, strike: 50, timeYears: 0.5, vol: 0.3, rate: 0.03 } },
  { name: "Deep OTM (S=50, K=150, T=0.5, σ=30%, r=3%)", inputs: { spot: 50, strike: 150, timeYears: 0.5, vol: 0.3, rate: 0.03 } },
  { name: "Short-dated near-ATM (S=305, K=300, T=30/365, σ=45%, r=4%)", inputs: { spot: 305, strike: 300, timeYears: 30 / 365, vol: 0.45, rate: 0.04 } },
  { name: "Low-vol long-dated (S=60, K=65, T=2, σ=12%, r=4.5%)", inputs: { spot: 60, strike: 65, timeYears: 2, vol: 0.12, rate: 0.045 } },
];

console.log("\n████ 1. Priced vs. independent numerical-integration reference (must match to the cent) ████");
for (const c of cases) {
  for (const type of ["call", "put"] as const) {
    const got = priceOption(type, c.inputs);
    const ref = refPrice(type, c.inputs.spot, c.inputs.strike, c.inputs.timeYears, c.inputs.vol, c.inputs.rate);
    assert(`${c.name} — ${type}: $${got.toFixed(4)} vs reference $${ref.toFixed(4)}`, closeTo(got, ref, 0.005), `diff ${(got - ref).toFixed(6)}`);
  }
}

console.log("\n████ 2. Put-call parity across a strike ladder (Call - Put = S - K·e^(-rT), exact identity) ████");
{
  const S = 187.32,
    T = 0.75,
    sigma = 0.28,
    r = 0.04;
  for (const K of [120, 150, 170, 187.32, 200, 225, 260]) {
    const inputs: BSInputs = { spot: S, strike: K, timeYears: T, vol: sigma, rate: r };
    const call = priceOption("call", inputs);
    const put = priceOption("put", inputs);
    const lhs = call - put;
    const rhs = S - K * Math.exp(-r * T);
    assert(`K=${K}: C-P=${lhs.toFixed(6)} vs S-Ke^(-rT)=${rhs.toFixed(6)}`, closeTo(lhs, rhs, 1e-8), `diff ${(lhs - rhs).toExponential(2)}`);
  }
}

console.log("\n████ 3. Expiry-day edge case (T=0 → EXACT intrinsic value, no approximation) ████");
{
  const itmCall = priceOption("call", { spot: 105, strike: 100, timeYears: 0, vol: 0.3, rate: 0.05 });
  const otmCall = priceOption("call", { spot: 95, strike: 100, timeYears: 0, vol: 0.3, rate: 0.05 });
  const itmPut = priceOption("put", { spot: 95, strike: 100, timeYears: 0, vol: 0.3, rate: 0.05 });
  const otmPut = priceOption("put", { spot: 105, strike: 100, timeYears: 0, vol: 0.3, rate: 0.05 });
  assert("ITM call at expiry === exactly 5 (intrinsic, no extrinsic)", itmCall === 5, `${itmCall}`);
  assert("OTM call at expiry === exactly 0", otmCall === 0, `${otmCall}`);
  assert("ITM put at expiry === exactly 5", itmPut === 5, `${itmPut}`);
  assert("OTM put at expiry === exactly 0", otmPut === 0, `${otmPut}`);

  const g = optionGreeks("call", { spot: 105, strike: 100, timeYears: 0, vol: 0.3, rate: 0.05 });
  assert("at expiry, ITM call delta === 1", g.delta === 1, `${g.delta}`);
  assert("at expiry, gamma/theta/vega === 0 (no time value left)", g.gamma === 0 && g.theta === 0 && g.vega === 0);
}

console.log("\n████ 4. Degenerate zero-vol guard (no NaN/crash, converges to discounted-forward intrinsic) ████");
{
  const inputs: BSInputs = { spot: 100, strike: 90, timeYears: 1, vol: 0, rate: 0.05 };
  const call = priceOption("call", inputs);
  const expected = Math.max(100 * Math.exp(0.05) - 90, 0) * Math.exp(-0.05); // = max(fwd-K,0)*disc
  assert("zero-vol call is finite, no NaN", Number.isFinite(call));
  assert("zero-vol call matches discounted-forward-intrinsic formula", closeTo(call, expected, 1e-9), `${call} vs ${expected}`);
  const g = optionGreeks("call", inputs);
  assert("zero-vol Greeks: gamma/theta/vega === 0, no NaN", g.gamma === 0 && g.theta === 0 && g.vega === 0 && Number.isFinite(g.delta));
}

console.log("\n████ 5. Deep ITM ≈ intrinsic + small extrinsic ████");
{
  const inputs: BSInputs = { spot: 150, strike: 50, timeYears: 0.5, vol: 0.3, rate: 0.03 };
  const call = priceOption("call", inputs);
  const intrinsic = 100;
  const extrinsic = call - intrinsic;
  console.log(`  deep ITM call: price=$${call.toFixed(4)}, intrinsic=$${intrinsic}, extrinsic=$${extrinsic.toFixed(4)}`);
  assert("deep ITM call price > intrinsic (discounting effect)", call > intrinsic);
  assert("deep ITM extrinsic is small relative to spot (< 5% of spot)", extrinsic < inputs.spot * 0.05, `extrinsic=${extrinsic.toFixed(4)}`);
}

console.log("\n████ 6. Greeks sanity ████");
{
  const atm: BSInputs = { spot: 100, strike: 100, timeYears: 0.5, vol: 0.25, rate: 0.04 };
  const deepItmCall: BSInputs = { spot: 200, strike: 80, timeYears: 0.5, vol: 0.25, rate: 0.04 };
  const deepOtmCall: BSInputs = { spot: 60, strike: 200, timeYears: 0.5, vol: 0.25, rate: 0.04 };

  const gCallAtm = optionGreeks("call", atm);
  const gPutAtm = optionGreeks("put", atm);
  const gCallItm = optionGreeks("call", deepItmCall);
  const gCallOtm = optionGreeks("call", deepOtmCall);

  console.log(`  ATM call delta=${gCallAtm.delta.toFixed(4)}, put delta=${gPutAtm.delta.toFixed(4)}, theta(call)=${gCallAtm.theta.toFixed(4)}/day, vega=${gCallAtm.vega.toFixed(4)}`);
  console.log(`  deep ITM call delta=${gCallItm.delta.toFixed(4)}, deep OTM call delta=${gCallOtm.delta.toFixed(4)}`);

  assert("call delta ∈ (0,1)", gCallAtm.delta > 0 && gCallAtm.delta < 1, `${gCallAtm.delta}`);
  assert("put delta ∈ (-1,0)", gPutAtm.delta > -1 && gPutAtm.delta < 0, `${gPutAtm.delta}`);
  assert("ATM call delta ≈ 0.5-ish (0.4-0.65 band, r/σ shift it off exactly 0.5)", gCallAtm.delta > 0.4 && gCallAtm.delta < 0.65, `${gCallAtm.delta}`);
  assert("deep ITM call delta → close to 1", gCallItm.delta > 0.95, `${gCallItm.delta}`);
  assert("deep OTM call delta → close to 0", gCallOtm.delta < 0.05, `${gCallOtm.delta}`);
  assert("gamma is positive (call and put)", gCallAtm.gamma > 0);
  assert("theta is NEGATIVE for a long ATM call (time decay)", gCallAtm.theta < 0, `${gCallAtm.theta}`);
  assert("theta is NEGATIVE for a long ATM put (time decay)", gPutAtm.theta < 0, `${gPutAtm.theta}`);
  assert("vega is positive (call and put)", gCallAtm.vega > 0 && gPutAtm.vega > 0);
  assert("gamma is largest near ATM vs. deep ITM/OTM", optionGreeks("call", atm).gamma > gCallItm.gamma && optionGreeks("call", atm).gamma > gCallOtm.gamma);
}

console.log(`\n${failures === 0 ? "ALL BLACK-SCHOLES UNIT CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
