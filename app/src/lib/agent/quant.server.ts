// AI Agent — QUANT layer (server-only, deterministic, transparent).
//
// Builds a candidate list from a curated universe, pulls live quote +
// Finnhub fundamentals, computes momentum / volatility / 52-wk-position
// signals, and scores+ranks them per risk level. No LLM here — fully
// explainable. Degrades gracefully when metrics are missing.

import { providerQuotes, fhMetrics, type SymbolMetrics } from "@/lib/marketData/finnhub.server";
import { MARKET_UNIVERSE } from "@/lib/marketData";
import type { Quote } from "@/lib/marketData/types";
import type { RiskLevel } from "@/lib/supabase/types";

const ETFS = ["SPY", "QQQ", "VOO"] as const;
export const AGENT_UNIVERSE: string[] = Array.from(new Set([...MARKET_UNIVERSE, ...ETFS]));

// A per-run snapshot of the universe's quotes + metrics. The market data is the
// SAME for every agent (only the risk-weighted scoring differs), so a batch can
// fetch it ONCE and reuse it for every user instead of re-fetching per user.
export type UniverseData = { quotes: Quote[]; metrics: SymbolMetrics[] };

export async function prefetchUniverse(): Promise<UniverseData> {
  const [quotes, metrics] = await Promise.all([
    providerQuotes(AGENT_UNIVERSE),
    Promise.all(AGENT_UNIVERSE.map((s) => fhMetrics(s).catch((): SymbolMetrics => ({ symbol: s })))),
  ]);
  return { quotes, metrics };
}

export type Candidate = {
  symbol: string;
  name: string;
  price: number;
  isEtf: boolean;
  signals: {
    momentum: number; // blended 13w/26w % return
    shortMom: number; // 4w % return
    beta: number; // volatility proxy
    pos52: number; // 0..1 position within 52-wk range
    dayChangePct: number;
  };
  score: number;
};

function z(values: number[]): (v: number) => number {
  const xs = values.filter((v) => Number.isFinite(v));
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const variance = xs.length ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length : 0;
  const sd = Math.sqrt(variance) || 1;
  return (v: number) => (Number.isFinite(v) ? (v - mean) / sd : 0);
}

/** Score + rank the universe for a risk level. Returns highest-first. Pass
 *  `prefetched` (from prefetchUniverse) to reuse one snapshot across many runs. */
export async function scoreCandidates(risk: RiskLevel, prefetched?: UniverseData): Promise<Candidate[]> {
  const { quotes, metrics } = prefetched ?? (await prefetchUniverse());
  const metricBySym = new Map(metrics.map((m) => [m.symbol, m]));

  const raw = quotes
    .filter((q) => q.price > 0)
    .map((q) => {
      const m = metricBySym.get(q.symbol) ?? { symbol: q.symbol };
      const momentum = ((m.return13w ?? 0) + (m.return26w ?? 0)) / 2;
      const shortMom = m.return4w ?? q.dayChangePct;
      const beta = m.beta ?? 1;
      const hi = m.week52High ?? q.week52High ?? q.price;
      const lo = m.week52Low ?? q.week52Low ?? q.price;
      const pos52 = hi > lo ? Math.min(1, Math.max(0, (q.price - lo) / (hi - lo))) : 0.5;
      const isEtf = (ETFS as readonly string[]).includes(q.symbol);
      return { symbol: q.symbol, name: q.name, price: q.price, isEtf, momentum, shortMom, beta, pos52, dayChangePct: q.dayChangePct };
    });

  const zMom = z(raw.map((r) => r.momentum));
  const zShort = z(raw.map((r) => r.shortMom));
  const zBeta = z(raw.map((r) => r.beta));

  const scored: Candidate[] = raw.map((r) => {
    const mom = zMom(r.momentum);
    const short = zShort(r.shortMom);
    const betaZ = zBeta(r.beta);
    const etfBonus = r.isEtf ? 1 : 0;

    let score: number;
    switch (risk) {
      case "aggressive":
        // chase momentum, tolerate/favor higher beta, ignore ETFs
        score = 0.55 * mom + 0.25 * short + 0.2 * betaZ;
        break;
      case "conservative":
        // steady momentum, punish high beta, reward diversifying ETFs
        score = 0.35 * mom + 0.05 * short - 0.45 * betaZ + 0.35 * etfBonus;
        break;
      default: // balanced
        score = 0.45 * mom + 0.15 * short - 0.1 * betaZ + 0.15 * etfBonus;
        break;
    }

    return {
      symbol: r.symbol,
      name: r.name,
      price: r.price,
      isEtf: r.isEtf,
      signals: { momentum: +r.momentum.toFixed(2), shortMom: +r.shortMom.toFixed(2), beta: +r.beta.toFixed(2), pos52: +r.pos52.toFixed(2), dayChangePct: +r.dayChangePct.toFixed(2) },
      score: +score.toFixed(3),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
