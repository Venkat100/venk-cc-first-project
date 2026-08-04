// Margin monitor (M1, server-only) — for every margin-enabled user WITH an
// outstanding loan, computes live equity vs. the maintenance requirement,
// transitions margin_status (ok/warning/call), and on a genuine call
// SIMULATES a forced liquidation using the SAME trade-execution RPCs a real
// order uses (so a liquidating sell pays down the loan first, logs a
// ledger row, etc. — identical bookkeeping to a voluntary sell).
//
// WHY ONLY margin_loan > 0 IS QUERIED: equity = cash + positions_value −
// margin_loan. With loan = 0, equity = cash + positions_value ≥
// positions_value ≥ positions_value × 0.30 = maintenance_requirement,
// because cash can never go negative (every trade function floors
// cash_used at the available cash). So a margin-enabled account with NO
// loan can mathematically never be under maintenance — checking it would
// be pure wasted work (a live-priced positions_value computation) for an
// outcome that's already proven impossible.
//
// LIQUIDATION SELECTION RULE: sell the SINGLE LARGEST position (stocks and
// option positions pooled together, by live market value) ENTIRELY, re-
// check equity, and repeat until it clears the requirement or nothing is
// left. Minimizes the NUMBER of trades needed to clear a call — simple,
// deterministic, and easy for a user to audit after the fact ("my biggest
// position went first"). A real broker might weigh liquidity or margin-
// ability differently; this is a documented v1 simplification, not the only
// reasonable rule.

import { getServiceClient, logIfFailed } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import { getRealizedVol } from "@/lib/options/volatility.server";
import { parseContractId, priceParsedContract } from "@/lib/options/chain.server";
import { getEnrichedOptionPositions } from "@/lib/options/valuation.server";
import { getPositionsValue } from "./valuation.server";
import { MARGIN_MAINTENANCE_PCT, MARGIN_WARNING_BUFFER_PCT } from "./config.server";

const round2 = (n: number) => Math.round(n * 100) / 100;

type MarginStatus = "ok" | "warning" | "call";

type Candidate =
  | { kind: "stock"; symbol: string; quantity: number; value: number }
  | { kind: "option"; contractId: string; symbol: string; contracts: number; value: number };

async function listPositionCandidates(userId: string): Promise<Candidate[]> {
  const admin = getServiceClient();
  const { data: holdings } = await admin.from("holdings").select("symbol, quantity").eq("user_id", userId);
  const candidates: Candidate[] = [];

  if (holdings && holdings.length > 0) {
    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    const quotes = await providerQuotes(symbols);
    const priceMap = new Map(quotes.map((q) => [q.symbol, q.price]));
    for (const h of holdings) {
      const price = priceMap.get(h.symbol) ?? 0;
      candidates.push({ kind: "stock", symbol: h.symbol, quantity: Number(h.quantity), value: round2(price * Number(h.quantity)) });
    }
  }

  const optionPositions = await getEnrichedOptionPositions(userId);
  for (const p of optionPositions) {
    candidates.push({ kind: "option", contractId: p.contractId, symbol: p.symbol, contracts: p.contracts, value: p.marketValue });
  }

  return candidates;
}

export type LiquidationDetail = {
  kind: "stock" | "option";
  symbol: string;
  quantity?: number;
  contracts?: number;
  price?: number;
  premium?: number;
  proceeds: number;
};

// Safety cap on liquidation iterations — a real user holds far fewer
// distinct positions than this; it exists purely to guarantee termination
// even under an unexpected data/pricing edge case, never expected to bind.
const MAX_LIQUIDATION_ITERATIONS = 20;

async function liquidateUntilCleared(userId: string, maintenanceReq: number): Promise<LiquidationDetail[]> {
  const admin = getServiceClient();
  const sold: LiquidationDetail[] = [];

  for (let i = 0; i < MAX_LIQUIDATION_ITERATIONS; i++) {
    const { data: profile } = await admin.from("profiles").select("cash_balance, margin_loan").eq("id", userId).single();
    if (!profile) break;
    const positionsValue = await getPositionsValue(userId);
    const equity = round2(Number(profile.cash_balance) + positionsValue - Number(profile.margin_loan));
    if (equity >= maintenanceReq || positionsValue <= 0) break;

    const candidates = await listPositionCandidates(userId);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.value - a.value);
    const biggest = candidates[0];

    if (biggest.kind === "stock") {
      const quote = await getServerQuote(biggest.symbol);
      const { data: rpc, error } = await admin.rpc("execute_trade", {
        p_user_id: userId,
        p_symbol: biggest.symbol,
        p_side: "sell",
        p_quantity: biggest.quantity,
        p_price: quote.price,
        p_positions_value: positionsValue,
      });
      if (error) throw new Error(`liquidation sell failed for ${biggest.symbol}: ${error.message}`);
      sold.push({ kind: "stock", symbol: biggest.symbol, quantity: biggest.quantity, price: quote.price, proceeds: round2(Number((rpc as { total: number }).total)) });
    } else {
      const parsed = parseContractId(biggest.contractId);
      if (!parsed) throw new Error(`could not parse contract id during liquidation: ${biggest.contractId}`);
      const [quote, vol] = await Promise.all([getServerQuote(parsed.symbol), getRealizedVol(parsed.symbol)]);
      const priced = priceParsedContract(parsed, quote.price, vol);
      const { data: rpc, error } = await admin.rpc("execute_option_trade", {
        p_user_id: userId,
        p_contract_id: biggest.contractId,
        p_symbol: parsed.symbol,
        p_opt_type: parsed.type,
        p_strike: parsed.strike,
        p_expiry: parsed.expiry,
        p_side: "sell_to_close",
        p_contracts: biggest.contracts,
        p_premium: priced.premium,
        p_positions_value: positionsValue,
      });
      if (error) throw new Error(`liquidation sell failed for ${biggest.contractId}: ${error.message}`);
      sold.push({ kind: "option", symbol: biggest.symbol, contracts: biggest.contracts, premium: priced.premium, proceeds: round2(Number((rpc as { total: number }).total)) });
    }
  }

  return sold;
}

function statusFor(equity: number, maintenanceReq: number): MarginStatus {
  if (equity < maintenanceReq) return "call";
  if (equity < round2(maintenanceReq * (1 + MARGIN_WARNING_BUFFER_PCT))) return "warning";
  return "ok";
}

export type MarginMonitorUserResult = {
  userId: string;
  previousStatus: MarginStatus;
  newStatus: MarginStatus;
  equity: number;
  positionsValue: number;
  maintenanceRequirement: number;
  liquidated?: LiquidationDetail[];
};

export type MarginMonitorSummary = {
  checked: number;
  warnings: number;
  calls: number;
  liquidations: number;
  results: MarginMonitorUserResult[];
  errors: string[];
};

/** `onlyUserId` scopes it to one account (verification / on-demand);
 *  omitted in production so the cron checks every margin-enabled borrower. */
export async function runMarginMonitor(opts: { onlyUserId?: string } = {}): Promise<MarginMonitorSummary> {
  const admin = getServiceClient();
  const errors: string[] = [];

  let q = admin.from("profiles").select("id, cash_balance, margin_loan, margin_status").eq("margin_enabled", true).gt("margin_loan", 0);
  if (opts.onlyUserId) q = q.eq("id", opts.onlyUserId);
  const { data: profiles, error } = await q;
  if (error) throw new Error("read profiles: " + error.message);

  const results: MarginMonitorUserResult[] = [];
  let warnings = 0;
  let calls = 0;
  let liquidations = 0;

  for (const p of profiles ?? []) {
    try {
      const positionsValue = await getPositionsValue(p.id);
      const equity = round2(Number(p.cash_balance) + positionsValue - Number(p.margin_loan));
      const maintenanceReq = round2(positionsValue * MARGIN_MAINTENANCE_PCT);
      const previousStatus = p.margin_status as MarginStatus;
      let newStatus = statusFor(equity, maintenanceReq);
      let liquidated: LiquidationDetail[] | undefined;

      // Log a transition event only when status actually CHANGES — avoids
      // spamming the ledger with a duplicate row every single run while the
      // account sits unchanged in the same state.
      if (newStatus !== previousStatus) {
        const { error: statusErr } = await admin.rpc("set_margin_status", { p_user_id: p.id, p_status: newStatus });
        if (statusErr) throw new Error(`set_margin_status failed: ${statusErr.message}`);
        if (newStatus === "warning" || newStatus === "call") {
          logIfFailed(`log '${newStatus}' margin_event for ${p.id}`, await admin.from("margin_events").insert({
            user_id: p.id,
            kind: newStatus,
            amount: equity,
            detail: { positionsValue, maintenanceRequirement: maintenanceReq, equity },
          }), errors);
        }
      }
      if (newStatus === "warning") warnings++;

      if (newStatus === "call") {
        calls++;
        liquidated = await liquidateUntilCleared(p.id, maintenanceReq);
        if (liquidated.length > 0) {
          liquidations++;
          logIfFailed(`log 'liquidation' margin_event for ${p.id}`, await admin.from("margin_events").insert({
            user_id: p.id,
            kind: "liquidation",
            amount: round2(liquidated.reduce((sum, l) => sum + l.proceeds, 0)),
            detail: { sold: liquidated, maintenanceRequirement: maintenanceReq },
          }), errors);

          // Recompute + persist the ACTUAL post-liquidation status rather
          // than assuming the loop's own exit condition ("equity ≥
          // maintenanceReq") still holds — positions_value/equity are
          // re-read fresh here, not inferred.
          const postPositionsValue = await getPositionsValue(p.id);
          const { data: postProfile } = await admin.from("profiles").select("cash_balance, margin_loan").eq("id", p.id).single();
          const postEquity = round2(Number(postProfile?.cash_balance ?? 0) + postPositionsValue - Number(postProfile?.margin_loan ?? 0));
          const postMaintenanceReq = round2(postPositionsValue * MARGIN_MAINTENANCE_PCT);
          const postStatus = statusFor(postEquity, postMaintenanceReq);
          const { error: postStatusErr } = await admin.rpc("set_margin_status", { p_user_id: p.id, p_status: postStatus });
          if (postStatusErr) throw new Error(`set_margin_status (post-liquidation) failed: ${postStatusErr.message}`);
          newStatus = postStatus;
        }
      }

      results.push({ userId: p.id, previousStatus, newStatus, equity, positionsValue, maintenanceRequirement: maintenanceReq, liquidated });
    } catch (e) {
      errors.push(`${p.id}: ${e instanceof Error ? e.message : "monitor failed"}`);
    }
  }

  return { checked: (profiles ?? []).length, warnings, calls, liquidations, results, errors };
}
