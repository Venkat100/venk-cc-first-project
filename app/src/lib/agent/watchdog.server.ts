// AI Agent — the "watchdog" (server-only, Phase 10.3).
//
// The CHEAP, FREQUENT risk loop. NO LLM calls — only live quotes for the
// symbols the agent already holds, plus protective sells. It maintains a
// SMART, anti-whipsaw TRAILING STOP per holding:
//
//   • The stop only RATCHETS UP, never down. On each run:
//         stop = max(existing stop, price × (1 − stopPct))
//     Because it never falls, it implicitly tracks the high-water mark, so a
//     position is sold only on a real drawdown FROM ITS PEAK. A small dip that
//     stays above the stop does nothing — this is what avoids whipsaw.
//   • stopPct is VOLATILITY-SIZED (wider for high-beta names so normal noise
//     doesn't eject them) and varies by risk level (aggressive tolerates wider
//     drawdowns to let winners run; conservative protects sooner).
//   • On breach (price ≤ trailing stop) → ONE protective SELL of the whole
//     position via agent_execute_trade; proceeds return to agent_cash and STAY
//     in the agent (the thinker redeploys them later — we never auto-rebuy here,
//     by design, to avoid churn).
//
// Reads ALL data server-side; prices are fetched server-side, never trusted
// from the client. Manual trigger for now (cron wiring is 10.5).

import { getServiceClient } from "@/lib/supabase/admin.server";
import { getQuotes } from "@/lib/marketData";
import { fhMetrics } from "@/lib/marketData/finnhub.server";
import type { RiskLevel } from "@/lib/supabase/types";

// ── Volatility-sized trailing-stop width ─────────────────────────────────────
// stopPct = clamp(base + betaSlope·(beta − 1), min, max).
// A market-beta (β≈1) name gets `base`; higher beta widens the stop, lower beta
// tightens it. Aggressive runs the widest stops (let winners breathe);
// conservative the tightest (protect capital sooner). Example widths (β shown):
//   β=1.0   → cons 8.0%  · bal 12.0% · agg 18.0%
//   β=2.5   → cons 14.0% · bal 19.5% · agg 27.0%   (AMD-like: much wider)
//   β=0.8   → cons 7.2%  · bal 11.0% · agg 16.8%   (calm name: tighter)
type StopParams = { base: number; betaSlope: number; min: number; max: number };
const STOP_PARAMS: Record<RiskLevel, StopParams> = {
  conservative: { base: 0.08, betaSlope: 0.04, min: 0.06, max: 0.18 },
  balanced: { base: 0.12, betaSlope: 0.05, min: 0.09, max: 0.25 },
  aggressive: { base: 0.18, betaSlope: 0.06, min: 0.12, max: 0.35 },
};

/** Trailing-stop width (fraction, e.g. 0.12 = 12%) for a beta + risk level. */
export function stopPct(beta: number | undefined, risk: RiskLevel): number {
  const p = STOP_PARAMS[risk];
  const b = Number.isFinite(beta) && (beta as number) > 0 ? (beta as number) : 1;
  return Math.min(p.max, Math.max(p.min, p.base + p.betaSlope * (b - 1)));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Dependency injection so price/volatility sources can be stubbed for
// deterministic verification. Production uses the real marketData layer.
export type WatchdogSources = {
  prices?: (symbols: string[]) => Promise<Map<string, number>>;
  betas?: (symbols: string[]) => Promise<Map<string, number>>;
};

async function livePrices(symbols: string[]): Promise<Map<string, number>> {
  const quotes = await getQuotes(symbols);
  const out = new Map<string, number>();
  for (const s of symbols) {
    const q = quotes.get(s);
    if (q && q.price > 0) out.set(s, q.price);
  }
  return out;
}

async function liveBetas(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const m = await fhMetrics(s);
        if (m.beta && m.beta > 0) out.set(s, m.beta);
      } catch {
        /* leave unset → defaults to 1 in stopPct */
      }
    }),
  );
  return out;
}

export type WatchdogAction = {
  symbol: string;
  price: number | null;
  beta: number;
  stopPct: number;
  prevStop: number | null;
  newStop: number | null;
  action: "sold" | "ratcheted" | "initialized" | "held" | "skipped";
  peak?: number;
  drawdownPct?: number;
  proceeds?: number;
  reason?: string;
};

export type WatchdogResult = {
  ran: boolean;
  reason?: string; // why it didn't run
  riskLevel?: RiskLevel;
  checked?: number;
  sells?: number;
  ratchets?: number;
  agentCashBefore?: number;
  agentCashAfter?: number;
  actions?: WatchdogAction[];
  errors?: string[];
};

export async function runWatchdog(userId: string, sources: WatchdogSources = {}): Promise<WatchdogResult> {
  const admin = getServiceClient();
  const errors: string[] = [];

  const { data: cfg, error: cfgErr } = await admin.from("agent_config").select("*").eq("user_id", userId).single();
  if (cfgErr || !cfg) return { ran: false, reason: "Agent is not set up yet." };
  if (!cfg.enabled) return { ran: false, reason: "Activate the agent before running the watchdog." };
  const risk = cfg.risk_level as RiskLevel;
  const agentCashBefore = Number(cfg.agent_cash);

  const { data: holdings, error: hErr } = await admin
    .from("agent_holdings")
    .select("symbol,quantity,trailing_stop_price")
    .eq("user_id", userId)
    .order("symbol");
  if (hErr) return { ran: false, reason: hErr.message };
  if (!holdings || holdings.length === 0) return { ran: false, reason: "The agent has no holdings to watch." };

  const symbols = holdings.map((h) => h.symbol);
  const priceFn = sources.prices ?? livePrices;
  const betaFn = sources.betas ?? liveBetas;

  let priceMap = new Map<string, number>();
  let betaMap = new Map<string, number>();
  try {
    priceMap = await priceFn(symbols);
  } catch (e) {
    errors.push(`price fetch failed: ${e instanceof Error ? e.message : "error"}`);
  }
  try {
    betaMap = await betaFn(symbols);
  } catch (e) {
    errors.push(`beta fetch failed: ${e instanceof Error ? e.message : "error"}`);
  }

  const actions: WatchdogAction[] = [];
  let sells = 0;
  let ratchets = 0;
  let agentCashAfter = agentCashBefore;

  for (const h of holdings) {
    const symbol = h.symbol;
    const beta = betaMap.get(symbol) ?? 1;
    const pct = stopPct(beta, risk);
    const price = priceMap.get(symbol);

    // No live price → skip safely (never sell on missing data).
    if (price == null || !(price > 0)) {
      errors.push(`no live price for ${symbol} — skipped`);
      actions.push({ symbol, price: null, beta: round2(beta), stopPct: round2(pct), prevStop: h.trailing_stop_price != null ? Number(h.trailing_stop_price) : null, newStop: h.trailing_stop_price != null ? Number(h.trailing_stop_price) : null, action: "skipped" });
      continue;
    }

    const prevStop = h.trailing_stop_price != null ? Number(h.trailing_stop_price) : null;
    const candidate = price * (1 - pct);
    const newStop = prevStop == null ? candidate : Math.max(prevStop, candidate);
    // Breach ⟺ an established stop is at/above the live price (only possible
    // when price ≤ prevStop, i.e. a real drawdown from the high-water peak).
    const breach = prevStop != null && price <= newStop;

    if (breach) {
      const qty = Number(h.quantity);
      const peak = newStop / (1 - pct); // high-water mark implied by the ratcheted stop
      const drawdownPct = ((price - peak) / peak) * 100;
      const reason = `Sold ${symbol}: price $${price.toFixed(2)} fell below its trailing stop $${newStop.toFixed(2)} (${drawdownPct.toFixed(1)}% from its $${peak.toFixed(2)} peak). Proceeds stay in the agent for the thinker to redeploy.`;

      const { data: rpc, error } = await admin.rpc("agent_execute_trade", {
        p_user_id: userId,
        p_symbol: symbol,
        p_side: "sell",
        p_quantity: qty,
        p_price: price,
        p_reason: reason,
      });
      if (error) {
        errors.push(`sell ${symbol}: ${error.message}`);
        actions.push({ symbol, price, beta: round2(beta), stopPct: round2(pct), prevStop, newStop, action: "skipped" });
        continue;
      }
      agentCashAfter = Number((rpc as Record<string, unknown>).agent_cash);
      sells += 1;
      const proceeds = qty * price;
      await admin.from("agent_decisions").insert({
        user_id: userId,
        action: "sell",
        symbol,
        rationale: reason,
        signals: { price: round2(price), stop: round2(newStop), peak: round2(peak), drawdown_pct: round2(drawdownPct), beta: round2(beta), stop_pct: round2(pct), proceeds: round2(proceeds), risk },
      });
      actions.push({ symbol, price, beta: round2(beta), stopPct: round2(pct), prevStop, newStop, action: "sold", peak: round2(peak), drawdownPct: round2(drawdownPct), proceeds: round2(proceeds), reason });
      continue;
    }

    // No breach → initialize or ratchet the stop UP (never down). A dip that
    // didn't breach leaves the stop unchanged ("held") — no trade, no whipsaw.
    if (prevStop == null || newStop > prevStop + 1e-9) {
      await admin.from("agent_holdings").update({ trailing_stop_price: newStop, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("symbol", symbol);
      if (prevStop != null) ratchets += 1;
      actions.push({ symbol, price, beta: round2(beta), stopPct: round2(pct), prevStop, newStop: round2(newStop), action: prevStop == null ? "initialized" : "ratcheted" });
    } else {
      actions.push({ symbol, price, beta: round2(beta), stopPct: round2(pct), prevStop, newStop: prevStop, action: "held" });
    }
  }

  // Brief run summary entry.
  await admin.from("agent_decisions").insert({
    user_id: userId,
    action: "watchdog",
    symbol: null,
    rationale: `Watchdog checked ${holdings.length} holding(s): ${sells} protective sell(s), ${ratchets} stop(s) raised.`,
    signals: { risk, checked: holdings.length, sells, ratchets, agent_cash_before: round2(agentCashBefore), agent_cash_after: round2(agentCashAfter) },
  });

  return { ran: true, riskLevel: risk, checked: holdings.length, sells, ratchets, agentCashBefore: round2(agentCashBefore), agentCashAfter: round2(agentCashAfter), actions, errors };
}
