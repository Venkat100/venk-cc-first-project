// AI Agent — gentle rebalancing planner (Phase 10 hardening #1, extended by
// the 2026-08-16 audit's Tier-1 fix pass — see AGENT-AUDIT.md).
//
// Pure, deterministic sizing logic shared by the thinker. Given target weights,
// current holdings, live prices and available cash, it produces the MINIMAL set
// of trades needed — deliberately avoiding daily micro-churn:
//
//   1. DRIFT BAND (hysteresis): a target position is only traded when its weight
//      deviates from target by more than DRIFT_BAND (absolute, in fraction-of-
//      capital). Within the band → leave it alone (no trade).
//   2. PREFER CASH over selling: underweight targets are filled with available
//      agent_cash first. A held position is only TRIMMED if it is meaningfully
//      OVER its target (beyond the band) or is no longer in the target set.
//   3. RE-ENTRY COOLDOWN: symbols the watchdog protective-sold recently are not
//      rebought (the caller passes them in `cooldown`); we never buy them here.
//   4. MINIMUM HOLDING PERIOD (membership stickiness): a position the thinker
//      itself opened cannot be fully EXITED again until it's been held at least
//      MIN_HOLDING_DAYS — see the section 1 comment below for why this exists
//      and why it's scoped to full exits only.
//
// All existing guardrails are respected: never spend below the cash buffer,
// never exceed the max single-position cap, never overspend agent_cash.
//
// FRACTIONAL SHARES (AGENT-AUDIT.md Part 3/7, issue #38): buy/sell sizing was
// whole-shares-only (`Math.floor`) until this pass — a real production agent
// funded at $1,000 could never afford a single whole share of any candidate at
// its guardrail-sized per-position budget, and silently traded nothing for 3+
// weeks. `agent_execute_trade`'s SQL signature already takes `numeric` — this
// was purely an application-layer restriction, matching how the main manual-
// trading engine has supported fractional/dollar-based investing since R2.
// Quantities now round to 6dp (`Math.round(x * 1e6) / 1e6`, the SAME precision
// the main engine's own dollar-based buy path already uses — see
// lib/trading/functions.ts). MIN_TRADE_DOLLARS replaces the old "at least one
// whole share" floor with a dollar-value floor, so a fractional buy/sell still
// has to be worth executing (not dust), instead of being priced out entirely.

// Absolute drift band: 5 percentage points of total agent capital. A target
// position within ±5pp of its target weight is left untouched. Chosen as a
// clear, explainable absolute band (vs a relative one) that kills day-to-day
// noise while still acting on genuine drift.
export const DRIFT_BAND = 0.05;

// Re-entry cooldown: don't rebuy a watchdog stop-sold name for this many days.
// Calendar days, sized to comfortably cover ~3 trading days incl. a weekend.
export const COOLDOWN_DAYS = 4;

// Minimum holding period (issue #39): the thinker may not fully EXIT a
// position it opened until it's been held this many calendar days. Scoped
// narrowly — this guards FULL EXITS only ("no longer in the target
// portfolio"). Drift-band TRIMS and watchdog protective SELLS are both
// untouched: a trim still enforces the position-cap guardrail even during
// the protection window, and a watchdog stop-sell is a genuine risk event
// that must never be blocked by a membership-noise guard. Chosen over a
// score-based hysteresis (a bigger score gap required to exit than to enter)
// because it's simpler, fully deterministic, easy to explain in a decision-
// log line, and directly targets the observed failure pattern: real
// production churn (AGENT-AUDIT.md Part 2) showed AMZN re-entering 1–3 days
// after being exited, repeatedly, for both real aggressive agents. 5 days
// comfortably covers a full trading week (so a single bad day's score dip
// can't round-trip a position) while staying short enough that a position
// whose thesis has genuinely broken is still fully exitable well within two
// weeks. Slightly longer than COOLDOWN_DAYS (4) since it protects a distinct,
// independent membership signal, not the same one.
export const MIN_HOLDING_DAYS = 5;

// Minimum dollar size for a fractional buy or trim to be worth executing —
// avoids a "buy $0.03 of AMD" dust trade once whole-share rounding no longer
// provides a natural floor. $5 keeps genuinely tiny fractional positions
// possible (e.g. a $5 sliver of a $500 stock is a real, if small, position)
// while filtering out noise. Also the exact signal used to detect a
// genuinely-underfunded agent (issue #38b): if EVERY candidate is blocked by
// this floor rather than bought, the account is too small to construct a
// sensible portfolio at all, not merely "already at target."
export const MIN_TRADE_DOLLARS = 5;

export type PlanTarget = { symbol: string; weight: number; price: number; score: number; reason: string };
export type PlanHolding = { symbol: string; quantity: number; price: number };

export type PlanAction = {
  side: "buy" | "sell";
  kind: "buy" | "trim" | "exit";
  symbol: string;
  quantity: number;
  price: number;
  reason: string;
  isNewPosition: boolean;
};

export type RebalancePlan = {
  actions: PlanAction[];
  held: string[]; // target holdings left untouched (within band / no cash)
  cooldownSkipped: string[]; // target symbols not bought due to cooldown
  heldByMinPeriod: string[]; // holdings that WOULD have been exited but are protected by MIN_HOLDING_DAYS
  underfunded: boolean; // true when every underweight target was blocked by MIN_TRADE_DOLLARS, not by being at-target
  projectedCash: number;
};

export type PlanInput = {
  targets: PlanTarget[]; // normalized weights summing to ~1 (already cooldown-aware is fine; we double-guard)
  holdings: PlanHolding[];
  agentCash: number;
  totalCapital: number; // agentCash + Σ(holding qty × price)
  cashBuffer: number; // fraction kept as cash
  maxPosition: number; // max single-position cap (fraction of capital)
  cooldown: Set<string>;
  positionOpenedAt?: Map<string, Date>; // symbol -> when the CURRENT holding was most recently opened from zero
  now?: Date; // injectable for deterministic tests
  band?: number;
};

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Compute the minimal trade set under drift-band + cash-preference + cooldown
 *  + minimum-holding-period. */
export function planRebalance(input: PlanInput): RebalancePlan {
  const band = input.band ?? DRIFT_BAND;
  const now = input.now ?? new Date();
  const positionOpenedAt = input.positionOpenedAt ?? new Map<string, Date>();
  const { agentCash, totalCapital, cashBuffer, maxPosition, cooldown } = input;
  const cashFloor = totalCapital * cashBuffer;
  const investable = totalCapital * (1 - cashBuffer);

  const targetBySym = new Map(input.targets.map((t) => [t.symbol, t]));
  const heldBySym = new Map(input.holdings.map((h) => [h.symbol, h]));
  const priceBy = new Map<string, number>();
  for (const h of input.holdings) priceBy.set(h.symbol, h.price);
  for (const t of input.targets) priceBy.set(t.symbol, t.price);

  const actions: PlanAction[] = [];
  const held: string[] = [];
  const cooldownSkipped: string[] = [];
  const heldByMinPeriod: string[] = [];
  let cash = agentCash;

  const targetWoC = (t: PlanTarget) => (1 - cashBuffer) * t.weight; // target weight as fraction of total capital
  const curWoC = (dollars: number) => (totalCapital > 0 ? dollars / totalCapital : 0);
  const daysHeld = (symbol: string): number | null => {
    const opened = positionOpenedAt.get(symbol);
    if (!opened) return null;
    return (now.getTime() - opened.getTime()) / 86_400_000;
  };

  // ── 1) SELLS: exit non-target holdings + trim positions over the band ───────
  const soldQty = new Map<string, number>();
  for (const h of input.holdings) {
    const price = h.price;
    const curDollars = h.quantity * price;
    const tgt = targetBySym.get(h.symbol);

    if (!tgt) {
      // No longer in the target set → exit fully (deliberate, not micro-churn)
      // — UNLESS this position is still inside its minimum holding period,
      // in which case membership noise (not a genuine thesis change) is the
      // most likely cause and we leave it alone rather than round-trip it.
      if (h.quantity > 0 && price > 0) {
        const held_days = daysHeld(h.symbol);
        if (held_days !== null && held_days < MIN_HOLDING_DAYS) {
          heldByMinPeriod.push(h.symbol);
          continue;
        }
        actions.push({ side: "sell", kind: "exit", symbol: h.symbol, quantity: h.quantity, price, reason: `Exited ${h.symbol}: no longer in the target portfolio.`, isNewPosition: false });
        cash += curDollars;
        soldQty.set(h.symbol, h.quantity);
      }
      continue;
    }

    const tgtDollars = investable * tgt.weight;
    const drift = curWoC(curDollars) - targetWoC(tgt); // + = overweight
    if (drift > band && price > 0) {
      const sellQty = round6((curDollars - tgtDollars) / price);
      if (sellQty > 0 && sellQty * price >= MIN_TRADE_DOLLARS) {
        actions.push({ side: "sell", kind: "trim", symbol: h.symbol, quantity: sellQty, price, reason: `Trimmed ${h.symbol}: ${pct(curWoC(curDollars))} of capital vs ${pct(targetWoC(tgt))} target (beyond the ${pct(band)} drift band).`, isNewPosition: false });
        cash += sellQty * price;
        soldQty.set(h.symbol, sellQty);
      }
    }
  }

  const curDollarsAfter = (sym: string) => {
    const h = heldBySym.get(sym);
    if (!h) return 0;
    return (h.quantity - (soldQty.get(sym) ?? 0)) * (priceBy.get(sym) ?? 0);
  };

  // ── 2) BUYS: deploy available cash to underweight targets (best score first) ─
  for (const t of input.targets) if (cooldown.has(t.symbol)) cooldownSkipped.push(t.symbol);

  const underweight = input.targets
    .filter((t) => !cooldown.has(t.symbol) && t.price > 0)
    .filter((t) => targetWoC(t) - curWoC(curDollarsAfter(t.symbol)) > band)
    .sort((a, b) => b.score - a.score);

  let boughtCount = 0;
  let affordabilityBlocked = 0;
  for (const t of underweight) {
    const available = cash - cashFloor;
    if (available <= 0) break;
    const tgtDollars = investable * t.weight;
    const curD = curDollarsAfter(t.symbol);
    const capRoom = maxPosition * totalCapital - curD; // never exceed the position cap
    const buyDollars = Math.min(tgtDollars - curD, available, capRoom);
    if (buyDollars < MIN_TRADE_DOLLARS) {
      affordabilityBlocked++;
      continue;
    }
    const qty = round6(buyDollars / t.price);
    if (qty <= 0) {
      affordabilityBlocked++;
      continue;
    }
    const cost = round6(qty * t.price);
    if (cost > cash) continue; // never overspend agent_cash
    actions.push({ side: "buy", kind: "buy", symbol: t.symbol, quantity: qty, price: t.price, reason: t.reason, isNewPosition: !heldBySym.has(t.symbol) });
    cash -= cost;
    boughtCount++;
  }

  // Genuinely underfunded: every single underweight candidate was blocked by
  // the dollar-value floor (not a mix with e.g. cash-floor exhaustion after
  // successfully buying others) AND nothing got bought. Distinct from "at
  // target" (underweight.length === 0, the normal/healthy no-trade case).
  const underfunded = boughtCount === 0 && underweight.length > 0 && affordabilityBlocked === underweight.length;

  // ── 3) HELD: target holdings we deliberately left alone ─────────────────────
  const traded = new Set(actions.map((a) => a.symbol));
  for (const t of input.targets) {
    if (cooldown.has(t.symbol)) continue;
    if (!traded.has(t.symbol) && heldBySym.has(t.symbol)) held.push(t.symbol);
  }

  return { actions, held, cooldownSkipped, heldByMinPeriod, underfunded, projectedCash: cash };
}
