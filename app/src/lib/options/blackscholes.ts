// Black-Scholes European option pricing — PURE math, no I/O, no server/client
// distinction needed (safe to import anywhere, but only used server-side today).
//
// Standard formulas (Black & Scholes 1973 / Merton 1973), continuous dividend
// yield assumed 0 (fine for v1 — most large caps' dividend yield is small
// relative to the other inputs; a documented simplification, not an oversight):
//
//   d1 = [ln(S/K) + (r + σ²/2)·T] / (σ√T)
//   d2 = d1 - σ√T
//   Call = S·N(d1) - K·e^(-rT)·N(d2)
//   Put  = K·e^(-rT)·N(-d2) - S·N(-d1)
//
// Greeks (standard closed forms, same d1/d2):
//   delta_call = N(d1)              delta_put = N(d1) - 1
//   gamma      = φ(d1) / (S·σ·√T)   (identical for call and put)
//   vega       = S·φ(d1)·√T         (identical for call and put; RAW per 1.00
//                                     [=100 percentage points] change in σ —
//                                     we return it scaled ×0.01, i.e. price
//                                     change per 1 PERCENTAGE POINT of vol,
//                                     matching how retail platforms quote it)
//   theta_call = -(S·φ(d1)·σ)/(2√T) - r·K·e^(-rT)·N(d2)   (RAW per YEAR;
//   theta_put  = -(S·φ(d1)·σ)/(2√T) + r·K·e^(-rT)·N(-d2)   we return PER DAY,
//                                                            i.e. ÷365, again
//                                                            matching how
//                                                            retail platforms
//                                                            show "time decay
//                                                            per day")
//
// where N = standard normal CDF, φ = standard normal PDF.

export type OptionType = "call" | "put";

export type BSInputs = {
  /** S — current price of the underlying. Must be > 0. */
  spot: number;
  /** K — strike price. Must be > 0. */
  strike: number;
  /** T — time to expiry, in YEARS. 0 = expiry day (intrinsic value only). */
  timeYears: number;
  /** σ — annualized volatility, as a decimal (0.25 = 25%). */
  vol: number;
  /** r — annualized risk-free rate, as a decimal (0.04 = 4%). */
  rate: number;
};

export type Greeks = {
  /** dPrice/dSpot. Call ∈ (0,1), put ∈ (-1,0). */
  delta: number;
  /** dDelta/dSpot. Same sign/value for calls and puts. */
  gamma: number;
  /** dPrice/dTime, PER CALENDAR DAY (annual theta ÷ 365). Usually negative
   *  for a long option (time decay works against the holder). */
  theta: number;
  /** dPrice/dVol, PER 1 PERCENTAGE POINT of vol (raw vega × 0.01). */
  vega: number;
};

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal PDF: φ(x) = e^(-x²/2) / √(2π). */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** erf(x) via the Abramowitz & Stegun 7.1.26 rational approximation.
 *  Max absolute error ≈ 1.5e-7 — far tighter than the 2dp precision we round
 *  premiums to, so it never affects a displayed price or Greek. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF: N(x) = ½[1 + erf(x/√2)]. */
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function assertPositiveInputs(inputs: BSInputs): void {
  if (!(inputs.spot > 0)) throw new Error(`Black-Scholes: spot must be > 0, got ${inputs.spot}`);
  if (!(inputs.strike > 0)) throw new Error(`Black-Scholes: strike must be > 0, got ${inputs.strike}`);
}

/** d1/d2 for T>0 and vol>0 only — callers must have already handled the T≤0
 *  and vol≤0 degenerate cases before calling this. */
function d1d2(inputs: BSInputs): { d1: number; d2: number } {
  const { spot, strike, timeYears: T, vol: sigma, rate: r } = inputs;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return { d1, d2 };
}

function intrinsic(type: OptionType, spot: number, strike: number): number {
  return type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

/** Forward (risk-neutral drifted) price of the underlying at expiry, used as
 *  the deep-degenerate (σ≤0) fallback for both price and delta below. */
function forwardPrice(spot: number, rate: number, T: number): number {
  return spot * Math.exp(rate * T);
}

/**
 * European option price.
 *
 * Edge cases (handled exactly, not approximated):
 *  - T ≤ 0 (expiry day or past): price = intrinsic value exactly. No time
 *    value can remain once expiry has arrived.
 *  - vol ≤ 0 with T > 0: a degenerate "certain" world — the standard T→0-of-
 *    the-BS-formula limit as σ→0 is the DISCOUNTED forward intrinsic value,
 *    max(S·e^(rT) - K, 0)·e^(-rT) for a call (equivalently
 *    max(S - K·e^(-rT), 0)) — NOT today's intrinsic, because the underlying
 *    is still expected to drift at the risk-free rate over the remaining
 *    time even with zero uncertainty. Guarded here purely so the function
 *    never divides by zero / returns NaN if called with vol=0; in practice
 *    our realized-vol estimator is clamped to a [10%,150%] floor/ceiling and
 *    never actually produces 0.
 */
export function priceOption(type: OptionType, inputs: BSInputs): number {
  assertPositiveInputs(inputs);
  const { spot, strike, timeYears: T, vol: sigma, rate: r } = inputs;

  if (T <= 0) return intrinsic(type, spot, strike);

  if (sigma <= 0) {
    const disc = Math.exp(-r * T);
    const fwd = forwardPrice(spot, r, T);
    return type === "call" ? Math.max(fwd - strike, 0) * disc : Math.max(strike - fwd, 0) * disc;
  }

  const { d1, d2 } = d1d2(inputs);
  const disc = Math.exp(-r * T);
  if (type === "call") return spot * normCdf(d1) - strike * disc * normCdf(d2);
  return strike * disc * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Greeks. Same edge-case handling as `priceOption`: at T≤0 or vol≤0 there is
 * no remaining time value, so gamma/theta/vega are exactly 0 and delta
 * degrades to a step function (1/0 for a call, -1/0 for a put, based on
 * whether the option is in the money at/near expiry under the same
 * degenerate forward-price logic used for pricing above).
 */
export function optionGreeks(type: OptionType, inputs: BSInputs): Greeks {
  assertPositiveInputs(inputs);
  const { spot, strike, timeYears: T, vol: sigma, rate: r } = inputs;

  if (T <= 0) {
    const itm = type === "call" ? spot > strike : spot < strike;
    const delta = itm ? (type === "call" ? 1 : -1) : 0;
    return { delta, gamma: 0, theta: 0, vega: 0 };
  }

  if (sigma <= 0) {
    const fwd = forwardPrice(spot, r, T);
    const itm = type === "call" ? fwd > strike : fwd < strike;
    const delta = itm ? (type === "call" ? 1 : -1) : 0;
    return { delta, gamma: 0, theta: 0, vega: 0 };
  }

  const { d1, d2 } = d1d2(inputs);
  const sqrtT = Math.sqrt(T);
  const disc = Math.exp(-r * T);
  const pdf1 = normPdf(d1);

  const delta = type === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf1 / (spot * sigma * sqrtT);
  const vegaRaw = spot * pdf1 * sqrtT;
  const vega = vegaRaw * 0.01; // per 1 percentage point of vol

  const thetaAnnual =
    type === "call"
      ? -(spot * pdf1 * sigma) / (2 * sqrtT) - r * strike * disc * normCdf(d2)
      : -(spot * pdf1 * sigma) / (2 * sqrtT) + r * strike * disc * normCdf(-d2);
  const theta = thetaAnnual / 365; // per calendar day

  return { delta, gamma, theta, vega };
}

/** Convenience: price + Greeks in one call (chain generation wants both). */
export function priceAndGreeks(type: OptionType, inputs: BSInputs): { price: number; greeks: Greeks } {
  return { price: priceOption(type, inputs), greeks: optionGreeks(type, inputs) };
}
