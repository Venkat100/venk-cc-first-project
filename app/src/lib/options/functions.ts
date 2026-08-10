// Options — TanStack Start server functions. JWT-verified so the chain is
// only generated for signed-in users, and runs server-side so the market
// data + pricing math never reach the browser (the client only ever sees the
// finished chain JSON).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { cached } from "@/lib/marketData/cache.server";
import { getRealizedVol } from "./volatility.server";
import { buildChain, parseContractId, priceParsedContract, type OptionChain } from "./chain.server";
import { getEnrichedOptionPositions, type EnrichedOptionPosition } from "./valuation.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { track } from "@/lib/analytics/track.server";

export type OptionChainResponse = { ok: true; chain: OptionChain } | { ok: false; error: string };

// CACHING NOTE (why in-memory is fine here, per the project's serverless
// rule that in-memory state doesn't survive between Vercel invocations): a
// generated chain is DERIVED data, cheaply recomputable from two already-
// cached inputs (the live quote, cached ~30s; the realized-vol candle
// series, cached ~1 day) — it is NOT itself a paid external call. A cold
// invocation that misses this cache just recomputes the chain locally
// (pure math, no extra network round-trip beyond the two already-cheap/
// already-cached fetches it depends on), unlike e.g. the AI Insights day-
// cache where a miss would cost a real paid Claude call. A 1-hour TTL (not
// a full day, unlike the once-daily AI insight) balances not recomputing on
// every click against staying reasonably fresh to intraday spot moves,
// which change premiums throughout the trading day.
const CHAIN_TTL = 60 * 60_000;

export const getOptionChainFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), symbol: z.string().min(1).max(12) }))
  .handler(async ({ data }): Promise<OptionChainResponse> => {
    try {
      await verifyUser(data.accessToken); // gate to signed-in users; the chain itself isn't user-specific
      const sym = data.symbol.toUpperCase();
      const chain = await cached(`optionchain:${sym}`, CHAIN_TTL, async () => {
        const [quotes, vol] = await Promise.all([providerQuotes([sym]), getRealizedVol(sym)]);
        const q = quotes[0];
        if (!q || !(q.price > 0)) throw new Error(`No live data for ${sym}.`);
        return buildChain({ symbol: sym, spot: q.price, vol });
      });
      return { ok: true, chain };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't generate an option chain right now." };
    }
  });

// ── Trade execution (O2) ────────────────────────────────────────────────────
//
// Security boundary — identical model to lib/trading/functions.ts (Phase 6):
//   1. Caller's identity comes from a VERIFIED Supabase JWT (verifyUser), not
//      a client-sent user_id.
//   2. The contract's terms (symbol/type/strike/expiry) come ONLY from
//      re-parsing the stable contractId server-side — the client never sends
//      them directly, so there's nothing to spoof beyond a string the server
//      independently re-derives and re-validates.
//   3. The premium is computed SERVER-SIDE (live spot + realized vol →
//      Black-Scholes), never accepted from the client — the input schema
//      below has no `premium` field at all, so even a doctored payload would
//      have it silently stripped by Zod before the handler ever runs.
//   4. The actual mutation runs in the DB via execute_option_trade(), called
//      with the service-role key — execute-granted to service_role only.
//   5. All money/position math + atomicity + row locking happen in Postgres.

export type OptionSide = "buy_to_open" | "sell_to_close";

export type OptionTradeResult = {
  cashBalance: number;
  marginLoan: number;
  contractId: string;
  symbol: string;
  side: OptionSide;
  contracts: number;
  premium: number; // per-contract, at fill
  total: number; // premium × 100 × contracts
  positionContracts: number;
  positionAvgPremium: number | null;
};

export type OptionTradeResponse = { ok: true; result: OptionTradeResult } | { ok: false; error: string };

function friendlyTrade(token: string): string {
  switch (token) {
    case "insufficient_funds":
      return "Not enough buying power for this order.";
    case "insufficient_contracts":
      return "You don't have enough contracts to sell.";
    case "invalid_contracts":
      return "Enter a whole number of contracts greater than zero.";
    case "invalid_premium":
    case "no_price":
      return "No live price available right now — please try again in a moment.";
    case "invalid_side":
      return "Invalid order side.";
    case "invalid_opt_type":
      return "Invalid option type.";
    case "expired_contract":
      return "This contract has already expired.";
    case "unknown_contract":
      return "That contract couldn't be recognized — please refresh the chain and try again.";
    case "profile_not_found":
      return "We couldn't find your account.";
    case "not_signed_in":
      return "Your session has expired — please sign in again.";
    default:
      // Surface Postgres' "…: insufficient_funds" style messages cleanly.
      for (const key of ["insufficient_funds", "insufficient_contracts", "invalid_contracts", "invalid_premium", "expired_contract"]) {
        if (token.includes(key)) return friendlyTrade(key);
      }
      return "Sorry — that order couldn't be completed. Please try again.";
  }
}

// Exported (not just inlined below) so it can be imported and exercised
// directly in verification — proving, with the REAL schema object rather
// than a hand-copied reconstruction, that an extra `premium` field a client
// might try to smuggle in gets silently stripped before the handler runs
// (z.object()'s default behavior — no `.passthrough()` anywhere here).
export const executeOptionTradeInputSchema = z.object({
  accessToken: z.string().min(1),
  contractId: z.string().min(1),
  side: z.enum(["buy_to_open", "sell_to_close"]),
  contracts: z.number().int().positive(),
});

export const executeOptionTradeFn = createServerFn({ method: "POST" })
  .inputValidator(executeOptionTradeInputSchema)
  .handler(async ({ data }): Promise<OptionTradeResponse> => {
    try {
      // 1) Identity from the verified JWT.
      const userId = await verifyUser(data.accessToken);

      // 2) Recover the contract's terms server-side from the id alone.
      const parsed = parseContractId(data.contractId);
      if (!parsed) return { ok: false, error: friendlyTrade("unknown_contract") };

      // 3) Reject an expired contract before doing any pricing work — the DB
      //    function re-checks this too, as a second, independent backstop.
      const todayIso = new Date().toISOString().slice(0, 10);
      if (parsed.expiry < todayIso) return { ok: false, error: friendlyTrade("expired_contract") };

      // 4) Server-computed premium (never the client's).
      const [quote, vol] = await Promise.all([getServerQuote(parsed.symbol), getRealizedVol(parsed.symbol)]);
      if (!quote || !(quote.price > 0)) return { ok: false, error: friendlyTrade("no_price") };
      const priced = priceParsedContract(parsed, quote.price, vol);

      // 5) Margin (M1): only compute positions_value (a live-priced pass over
      // ALL of the user's stock + option positions) when margin is actually
      // enabled — same cheap-check-first discipline as the equity trade path,
      // so an option trade with margin off costs zero extra provider calls.
      const admin = getServiceClient();
      const { data: marginProfile } = await admin.from("profiles").select("margin_enabled").eq("id", userId).single();
      const positionsValue = marginProfile?.margin_enabled ? await getPositionsValue(userId) : 0;

      // 6) Atomic execution in the DB via the service-role client.
      const { data: rpc, error } = await admin.rpc("execute_option_trade", {
        p_user_id: userId,
        p_contract_id: data.contractId.toUpperCase(),
        p_symbol: parsed.symbol,
        p_opt_type: parsed.type,
        p_strike: parsed.strike,
        p_expiry: parsed.expiry,
        p_side: data.side,
        p_contracts: data.contracts,
        p_premium: priced.premium,
        p_positions_value: positionsValue,
      });

      if (error) return { ok: false, error: friendlyTrade(error.message) };

      void track("option_trade", { userId, properties: { symbol: parsed.symbol, side: data.side } });

      const r = rpc as Record<string, unknown>;
      return {
        ok: true,
        result: {
          cashBalance: Number(r.cash_balance),
          marginLoan: Number(r.margin_loan ?? 0),
          contractId: String(r.contract_id),
          symbol: String(r.symbol),
          side: r.side as OptionSide,
          contracts: Number(r.contracts),
          premium: Number(r.premium),
          total: Number(r.total),
          positionContracts: Number(r.position_contracts),
          positionAvgPremium: r.position_avg_premium != null ? Number(r.position_avg_premium) : null,
        },
      };
    } catch (e) {
      return { ok: false, error: friendlyTrade(e instanceof Error ? e.message : "error") };
    }
  });

// ── Positions (O3) ──────────────────────────────────────────────────────────
//
// All of the signed-in user's option positions, LIVE-repriced via the same
// Black-Scholes path a chain uses (lib/options/valuation.server.ts) — never
// the stored avg_premium, which is only a cost basis. This is the single
// query Dashboard, Portfolio, and the Stock Detail Options tab all read
// through, so they can never disagree about current value/P&L.

export type OptionPositionsResponse = { ok: true; positions: EnrichedOptionPosition[] } | { ok: false; error: string };

export const getOptionPositionsFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1) }))
  .handler(async ({ data }): Promise<OptionPositionsResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const positions = await getEnrichedOptionPositions(userId);
      return { ok: true, positions };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't load your option positions right now." };
    }
  });
