// Live valuation for option positions — server-only. Single source of truth
// shared by the UI-facing getOptionPositionsFn (dashboard/portfolio/stock
// detail all read through it) AND the daily snapshot writer, so none of
// those can ever disagree about what a position is worth right now.
//
// PRICING: every position is re-priced live via the O1 Black-Scholes path
// (current spot + realized vol for its underlying, at its OWN strike/expiry)
// — never the stored avg_premium, which is only a cost basis. Spot is the
// same ~30s-cached quote the rest of the app already uses (getServerQuote's
// TTL.quote); realized vol is the same ~1-day-cached series the O1 chain
// endpoint and the AI Insights event study already share via
// dailyHistory.server.ts. Pricing a user's whole options book therefore adds
// AT MOST one extra quote fetch + one extra vol computation PER DISTINCT
// UNDERLYING SYMBOL held — not per position — and both are cache hits on any
// repeat call within their TTL windows, so navigating between
// Dashboard/Portfolio/Stock Detail in one session costs no extra provider
// calls beyond what those pages already fetch for their equity holdings.
//
// TODAY'S-CHANGE CONVENTION (a deliberate modeling choice, documented here
// rather than buried in a diff): a STOCK's day-change is (live price −
// previous close) — a real, quoted number. An OPTION has no real "yesterday's
// premium" on file (it's a generated instrument, not a quoted one), so we
// RECONSTRUCT one: reprice the SAME contract (same strike/type, the SAME
// time-to-expiry as right now, the SAME vol estimate) at the underlying's
// PREVIOUS CLOSE instead of its live price. Diffing current vs. that
// reconstruction isolates the DELTA-driven component of today's premium
// move — deliberately NOT also advancing time-to-expiry by a day, since
// today's live premium already reflects one day less of theta than
// yesterday would have shown; re-adding that decay to the "yesterday" side
// would double-count it. It's an honest approximation of "how much of my
// option's move is from the stock moving today," not a real market quote —
// same spirit as every other model-derived number in this epic.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import type { Quote } from "@/lib/marketData/types";
import { getRealizedVol } from "./volatility.server";
import { priceOption, type BSInputs, type OptionType } from "./blackscholes";
import { priceParsedContract, RISK_FREE_RATE } from "./chain.server";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function toUTCDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export type OptionPositionRow = {
  id: string;
  user_id: string;
  contract_id: string;
  symbol: string;
  opt_type: OptionType;
  strike: number;
  expiry: string; // YYYY-MM-DD
  contracts: number;
  avg_premium: number;
};

export type EnrichedOptionPosition = {
  id: string;
  userId: string;
  contractId: string;
  symbol: string;
  optType: OptionType;
  strike: number;
  expiry: string;
  contracts: number;
  avgPremium: number;
  currentPremium: number;
  marketValue: number; // currentPremium × 100 × contracts
  costBasis: number; // avgPremium × 100 × contracts
  unrealizedPL: number;
  unrealizedPLPct: number;
  dayChange: number; // $ contribution to today's change (see file header)
  daysToExpiry: number;
  delta: number;
};

/** PURE: enrich raw position rows given already-fetched quote/vol maps. No
 *  I/O — this is the ONE implementation of "what is this worth right now",
 *  reused by both the per-user (interactive) and batched (writer) paths. */
export function enrichPositions(rows: OptionPositionRow[], quotes: Map<string, Quote>, vols: Map<string, number>, asOf: Date = new Date()): EnrichedOptionPosition[] {
  const today = toUTCDateOnly(asOf);
  return rows.map((r) => {
    const quote = quotes.get(r.symbol);
    const vol = vols.get(r.symbol) ?? 0.1;
    const spot = quote?.price ?? 0;
    const prevClose = quote?.previousClose ?? spot;
    const contracts = Number(r.contracts);
    const avgPremium = Number(r.avg_premium);
    const strike = Number(r.strike);
    const parsed = { symbol: r.symbol, type: r.opt_type, strike, expiry: r.expiry };

    const expiryDate = new Date(`${r.expiry}T00:00:00Z`);
    const daysToExpiry = Math.max(0, Math.round((expiryDate.getTime() - today.getTime()) / MS_PER_DAY));
    const timeYears = Math.max(0, daysToExpiry / 365.25);

    const priced = spot > 0 ? priceParsedContract(parsed, spot, vol, RISK_FREE_RATE, asOf) : null;
    const currentPremium = priced ? priced.premium : avgPremium;

    // "Yesterday" reconstruction — see file header for the exact convention.
    const prevInputs: BSInputs = { spot: prevClose, strike, timeYears, vol, rate: RISK_FREE_RATE };
    const prevPremium = prevClose > 0 ? priceOption(r.opt_type, prevInputs) : currentPremium;

    const marketValue = round2(currentPremium * 100 * contracts);
    const costBasis = round2(avgPremium * 100 * contracts);
    const unrealizedPL = round2(marketValue - costBasis);
    const unrealizedPLPct = costBasis > 0 ? round2((unrealizedPL / costBasis) * 100) : 0;
    const dayChange = round2((currentPremium - prevPremium) * 100 * contracts);

    return {
      id: r.id,
      userId: r.user_id,
      contractId: r.contract_id,
      symbol: r.symbol,
      optType: r.opt_type,
      strike,
      expiry: r.expiry,
      contracts,
      avgPremium,
      currentPremium: round2(currentPremium),
      marketValue,
      costBasis,
      unrealizedPL,
      unrealizedPLPct,
      dayChange,
      daysToExpiry,
      delta: priced ? round4(priced.delta) : 0,
    };
  });
}

async function fetchQuotesAndVols(symbols: string[]): Promise<{ quotes: Map<string, Quote>; vols: Map<string, number> }> {
  if (symbols.length === 0) return { quotes: new Map(), vols: new Map() };
  const [quoteList, volList] = await Promise.all([
    providerQuotes(symbols),
    Promise.all(symbols.map(async (s) => [s, await getRealizedVol(s)] as const)),
  ]);
  return { quotes: new Map(quoteList.map((q) => [q.symbol, q])), vols: new Map(volList) };
}

/** All of ONE user's option positions, live-priced. Feeds the interactive UI
 *  (getOptionPositionsFn) — Dashboard/Portfolio/Stock-Detail all read this
 *  exact same computation via one shared React Query key client-side. */
export async function getEnrichedOptionPositions(userId: string): Promise<EnrichedOptionPosition[]> {
  const admin = getServiceClient();
  const { data, error } = await admin.from("option_positions").select("*").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as OptionPositionRow[];
  if (rows.length === 0) return [];
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const { quotes, vols } = await fetchQuotesAndVols(symbols);
  return enrichPositions(rows, quotes, vols);
}

/** ALL users' option positions (or just ONE user's, when `onlyUserId` is
 *  given), live-priced with ONE quote/vol fetch for the UNION of every
 *  symbol involved — the options-book counterpart to how the snapshot
 *  writer already batches equity holdings (see lib/snapshots/writer.server.ts,
 *  which scopes profiles/holdings/agent_holdings by the SAME parameter name).
 *  Returns each user's TOTAL options market value, keyed by user_id.
 *
 *  `onlyUserId` fixed 2026-08-15: this function previously took no
 *  parameter and ALWAYS fetched + live-priced the entire database's option
 *  book, even when its one caller (runSnapshots) was explicitly asked to
 *  scope to a single user — silently contradicting that call's own "don't
 *  fan out a price fetch across the whole user base" design intent (see
 *  writer.server.ts's header) for the options leg specifically, while the
 *  equities leg right next to it was correctly scoped. Root-caused as the
 *  actual source of verify-hardening-pass.ts's intermittent step timeouts:
 *  elapsed time (and Finnhub/Twelve-Data call volume) scaled with however
 *  many DISTINCT option symbols were open across every real + leftover-test
 *  account in the database at that moment — not with the one throwaway
 *  test user's own single position — which is exactly the kind of
 *  invisible, run-to-run-varying cost that produces a genuinely
 *  intermittent (not reproducible in isolation with a clean DB) failure. */
export async function getOptionsValueByUser(onlyUserId?: string): Promise<Map<string, number>> {
  const admin = getServiceClient();
  const q = admin.from("option_positions").select("*");
  const { data, error } = await (onlyUserId ? q.eq("user_id", onlyUserId) : q);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as OptionPositionRow[];
  const totals = new Map<string, number>();
  if (rows.length === 0) return totals;

  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const { quotes, vols } = await fetchQuotesAndVols(symbols);
  const enriched = enrichPositions(rows, quotes, vols);
  for (const p of enriched) totals.set(p.userId, round2((totals.get(p.userId) ?? 0) + p.marketValue));
  return totals;
}
