// AI Agent — gentle rebalancing planner (Phase 10 hardening #1).
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
//
// All existing guardrails are respected: never spend below the cash buffer,
// never exceed the max single-position cap, never overspend agent_cash.

// Absolute drift band: 5 percentage points of total agent capital. A target
// position within ±5pp of its target weight is left untouched. Chosen as a
// clear, explainable absolute band (vs a relative one) that kills day-to-day
// noise while still acting on genuine drift.
export const DRIFT_BAND = 0.05;

// Re-entry cooldown: don't rebuy a watchdog stop-sold name for this many days.
// Calendar days, sized to comfortably cover ~3 trading days incl. a weekend.
export const COOLDOWN_DAYS = 4;

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
  band?: number;
};

const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

/** Compute the minimal trade set under drift-band + cash-preference + cooldown. */
export function planRebalance(input: PlanInput): RebalancePlan {
  const band = input.band ?? DRIFT_BAND;
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
  let cash = agentCash;

  const targetWoC = (t: PlanTarget) => (1 - cashBuffer) * t.weight; // target weight as fraction of total capital
  const curWoC = (dollars: number) => (totalCapital > 0 ? dollars / totalCapital : 0);

  // ── 1) SELLS: exit non-target holdings + trim positions over the band ───────
  const soldQty = new Map<string, number>();
  for (const h of input.holdings) {
    const price = h.price;
    const curDollars = h.quantity * price;
    const tgt = targetBySym.get(h.symbol);

    if (!tgt) {
      // No longer in the target set → exit fully (deliberate, not micro-churn).
      if (h.quantity >= 1 && price > 0) {
        actions.push({ side: "sell", kind: "exit", symbol: h.symbol, quantity: h.quantity, price, reason: `Exited ${h.symbol}: no longer in the target portfolio.`, isNewPosition: false });
        cash += curDollars;
        soldQty.set(h.symbol, h.quantity);
      }
      continue;
    }

    const tgtDollars = investable * tgt.weight;
    const drift = curWoC(curDollars) - targetWoC(tgt); // + = overweight
    if (drift > band && price > 0) {
      const sellQty = Math.floor((curDollars - tgtDollars) / price);
      if (sellQty >= 1) {
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

  for (const t of underweight) {
    const available = cash - cashFloor;
    if (available <= 0) break;
    const tgtDollars = investable * t.weight;
    const curD = curDollarsAfter(t.symbol);
    const capRoom = maxPosition * totalCapital - curD; // never exceed the position cap
    const buyDollars = Math.min(tgtDollars - curD, available, capRoom);
    const qty = Math.floor(buyDollars / t.price);
    if (qty < 1) continue;
    const cost = qty * t.price;
    if (cost > cash) continue; // never overspend agent_cash
    actions.push({ side: "buy", kind: "buy", symbol: t.symbol, quantity: qty, price: t.price, reason: t.reason, isNewPosition: !heldBySym.has(t.symbol) });
    cash -= cost;
  }

  // ── 3) HELD: target holdings we deliberately left alone ─────────────────────
  const traded = new Set(actions.map((a) => a.symbol));
  for (const t of input.targets) {
    if (cooldown.has(t.symbol)) continue;
    if (!traded.has(t.symbol) && heldBySym.has(t.symbol)) held.push(t.symbol);
  }

  return { actions, held, cooldownSkipped, projectedCash: cash };
}
