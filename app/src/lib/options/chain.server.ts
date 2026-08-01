// Option chain GENERATION (server-only — only the live spot/vol inputs are
// server-fetched; the generation math itself is pure and independently
// testable by passing an explicit `asOf` date).
//
// Free market-data tiers don't include real options chains, so we GENERATE a
// plausible one: standard expiration dates + a strike ladder around the live
// spot price, each contract priced with our own Black-Scholes engine using a
// realized-volatility estimate as σ. Premiums are MODEL-DERIVED, not real
// market quotes — disclosed to users in the UI (O3), not hidden here.

import { priceOption, optionGreeks, type OptionType, type BSInputs } from "./blackscholes";

// A documented refinement lever, not sourced from a live rate feed (v1
// simplification) — a future pass could pull a real short-term Treasury
// yield instead of this constant.
export const RISK_FREE_RATE = 0.04;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ─── Dates (all UTC-midnight date-only, to avoid the classic off-by-one from
// mixing local-time and date-only values — same convention used elsewhere in
// this codebase, e.g. the simulator/insights date fixes noted in HANDOFF) ──

function toUTCDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

/** The 3rd Friday of a given (UTC) year/month — the standard monthly options
 *  expiration convention. `monthIndex0` is 0-based (0 = January). */
export function thirdFriday(year: number, monthIndex0: number): Date {
  const first = new Date(Date.UTC(year, monthIndex0, 1));
  const FRIDAY = 5; // Date#getUTCDay(): 0=Sun..6=Sat
  const firstFridayDate = 1 + ((FRIDAY - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, monthIndex0, firstFridayDate + 14));
}

const MONTHLY_EXPIRY_COUNT = 4;
const WEEKLY_EXPIRY_COUNT = 2;
const WEEKLY_SEARCH_HORIZON_DAYS = 45; // plenty of room to find 2 upcoming Fridays

/**
 * Generate the chain's expiration dates as of `asOf`: the next
 * MONTHLY_EXPIRY_COUNT standard monthly expiries (3rd Friday of each month,
 * today's month included if its 3rd Friday hasn't passed) plus the next
 * WEEKLY_EXPIRY_COUNT weekly Fridays that aren't already one of the
 * monthlies — sorted chronologically. If `asOf` itself is a 3rd Friday (or
 * any Friday), it's a valid same-day expiry and is included, matching how a
 * real contract can expire on the day you're looking at it.
 */
export function generateExpiries(asOf: Date): Date[] {
  const today = toUTCDateOnly(asOf);

  const monthlies: Date[] = [];
  for (let offset = 0; monthlies.length < MONTHLY_EXPIRY_COUNT && offset < 12; offset++) {
    const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
    const tf = thirdFriday(base.getUTCFullYear(), base.getUTCMonth());
    if (tf.getTime() >= today.getTime()) monthlies.push(tf);
  }
  const monthlyKeys = new Set(monthlies.map((d) => d.getTime()));

  const weeklies: Date[] = [];
  for (let i = 0; i <= WEEKLY_SEARCH_HORIZON_DAYS && weeklies.length < WEEKLY_EXPIRY_COUNT; i++) {
    const d = addDays(today, i);
    if (d.getUTCDay() !== 5) continue; // Friday only
    if (monthlyKeys.has(d.getTime())) continue; // already a monthly — don't duplicate
    weeklies.push(d);
  }

  return [...monthlies, ...weeklies].sort((a, b) => a.getTime() - b.getTime());
}

// ─── Strikes ────────────────────────────────────────────────────────────────

/** Strike spacing by underlying price magnitude — mirrors how real chains
 *  ladder strikes tighter for cheaper names and wider for expensive ones:
 *    spot <  $25   → $1 steps
 *    spot <  $100  → $2.50 steps
 *    spot <  $250  → $5 steps
 *    spot >= $250  → $10 steps
 */
export function strikeStep(spot: number): number {
  if (spot < 25) return 1;
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  return 10;
}

const STRIKE_COUNT = 11; // 5 below spot + ATM-nearest + 5 above ⇒ within the requested 8-12 range

/** Strikes laddered around `spot`, centered on the nearest step multiple. */
export function generateStrikes(spot: number, count: number = STRIKE_COUNT): number[] {
  const step = strikeStep(spot);
  const center = Math.round(spot / step) * step;
  const half = Math.floor(count / 2);
  const strikes: number[] = [];
  for (let i = -half; i <= half; i++) strikes.push(round2(center + i * step));
  return strikes.filter((s) => s > 0);
}

// ─── Contracts ──────────────────────────────────────────────────────────────

export type OptionContract = {
  contractId: string;
  symbol: string;
  expiry: string; // YYYY-MM-DD
  type: OptionType;
  strike: number;
  premium: number; // 2dp
  delta: number;
  intrinsic: number;
  extrinsic: number;
};

function formatStrikeForId(strike: number): string {
  // Strikes are already round2'd, so plain string coercion is clean
  // ("27.5", "200", not float noise like "27.499999999999996").
  return String(strike);
}

export type ParsedContract = {
  symbol: string;
  type: OptionType;
  strike: number;
  expiry: string; // YYYY-MM-DD
};

// SYMBOL-YYYY-MM-DD-{C|P}-STRIKE, e.g. "NVDA-2026-09-18-C-200" — the exact
// format produced by buildContract below. Assumes plain-letter symbols (no
// hyphens), true of every ticker this app trades (MARKET_UNIVERSE + live
// search results). Used by the trade engine (O2) to recover the contract's
// terms from the client-sent contractId — the client NEVER sends strike/
// expiry/type directly, only this one stable string, so there's nothing to
// tamper with beyond a string the server independently re-parses and re-prices.
const CONTRACT_ID_RE = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})-([CP])-(\d+(?:\.\d+)?)$/;

/** Parse a contractId back into its terms. Returns null (never throws) on any
 *  malformed/unrecognized id — the caller decides how to reject it. */
export function parseContractId(contractId: string): ParsedContract | null {
  const m = CONTRACT_ID_RE.exec(contractId.trim().toUpperCase());
  if (!m) return null;
  const [, symbol, expiry, cp, strikeStr] = m;
  const strike = Number(strikeStr);
  if (!(strike > 0)) return null;
  // Reject calendar-invalid dates (e.g. "2026-02-30") — Date silently rolls
  // them forward otherwise, which would price the wrong expiry.
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== expiry) return null;
  return { symbol, type: cp === "C" ? "call" : "put", strike, expiry };
}

/** Price ONE already-known contract (symbol/type/strike/expiry resolved, e.g.
 *  via parseContractId) against a live spot/vol — the single-contract sibling
 *  of buildChain's internal per-contract pricing, reused by the O2 trade
 *  engine so a trade's premium is computed the exact same way a chain would
 *  quote it. */
export function priceParsedContract(parsed: ParsedContract, spot: number, vol: number, rate: number = RISK_FREE_RATE, asOf: Date = new Date()): OptionContract {
  const expiryDate = new Date(`${parsed.expiry}T00:00:00Z`);
  const today = toUTCDateOnly(asOf);
  const daysToExpiry = Math.round((expiryDate.getTime() - today.getTime()) / MS_PER_DAY);
  const timeYears = Math.max(0, daysToExpiry / 365.25);
  return buildContract(parsed.type, parsed.symbol, expiryDate, parsed.strike, spot, timeYears, vol, rate);
}

function buildContract(type: OptionType, symbol: string, expiryDate: Date, strike: number, spot: number, timeYears: number, vol: number, rate: number): OptionContract {
  const inputs: BSInputs = { spot, strike, timeYears, vol, rate };
  const premium = round2(priceOption(type, inputs));
  const greeks = optionGreeks(type, inputs);
  const intrinsicVal = round2(type === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0));
  // NOT clamped to ≥0: extrinsic is DEFINED as premium − intrinsic, so
  // intrinsic + extrinsic reconciles to premium exactly, by construction. A
  // deep-ITM European put can genuinely price slightly BELOW raw intrinsic
  // value near expiry (the discounted strike K·e^(−rT) < K), which shows up
  // as a small negative extrinsic — a real, disclosed European-option
  // artifact, not a bug; clamping it to 0 would silently break the identity.
  const extrinsicVal = round2(premium - intrinsicVal);
  const sym = symbol.toUpperCase();
  return {
    contractId: `${sym}-${isoDate(expiryDate)}-${type === "call" ? "C" : "P"}-${formatStrikeForId(strike)}`,
    symbol: sym,
    expiry: isoDate(expiryDate),
    type,
    strike,
    premium,
    delta: round4(greeks.delta),
    intrinsic: intrinsicVal,
    extrinsic: extrinsicVal,
  };
}

// ─── Chain ──────────────────────────────────────────────────────────────────

export type StrikeRow = {
  strike: number;
  call: OptionContract;
  put: OptionContract;
};

export type OptionExpiry = {
  expiry: string; // YYYY-MM-DD
  daysToExpiry: number;
  strikes: StrikeRow[];
};

export type OptionChain = {
  symbol: string;
  spot: number;
  vol: number;
  rate: number;
  generatedAt: string;
  expiries: OptionExpiry[];
};

export type BuildChainInput = {
  symbol: string;
  spot: number;
  vol: number;
  rate?: number;
  /** Reference "today" — defaults to now; pass explicitly for deterministic tests. */
  asOf?: Date;
};

/** Generate a full option chain for `symbol` at the given spot/vol. Pure
 *  given its inputs — no I/O (the live spot/vol are fetched by the caller,
 *  e.g. the getOptionChainFn server function). */
export function buildChain(input: BuildChainInput): OptionChain {
  if (!(input.spot > 0)) throw new Error(`buildChain: spot must be > 0, got ${input.spot}`);
  if (!(input.vol > 0)) throw new Error(`buildChain: vol must be > 0, got ${input.vol}`);

  const rate = input.rate ?? RISK_FREE_RATE;
  const asOf = input.asOf ?? new Date();
  const today = toUTCDateOnly(asOf);
  const expiryDates = generateExpiries(asOf);
  const strikes = generateStrikes(input.spot);

  const expiries: OptionExpiry[] = expiryDates.map((expiryDate) => {
    const daysToExpiry = Math.round((expiryDate.getTime() - today.getTime()) / MS_PER_DAY);
    const timeYears = Math.max(0, daysToExpiry / 365.25);
    const strikeRows: StrikeRow[] = strikes.map((strike) => ({
      strike,
      call: buildContract("call", input.symbol, expiryDate, strike, input.spot, timeYears, input.vol, rate),
      put: buildContract("put", input.symbol, expiryDate, strike, input.spot, timeYears, input.vol, rate),
    }));
    return { expiry: isoDate(expiryDate), daysToExpiry, strikes: strikeRows };
  });

  return { symbol: input.symbol.toUpperCase(), spot: input.spot, vol: input.vol, rate, generatedAt: new Date().toISOString(), expiries };
}
