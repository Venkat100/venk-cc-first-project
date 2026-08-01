// Options — TanStack Start server functions. JWT-verified so the chain is
// only generated for signed-in users, and runs server-side so the market
// data + pricing math never reach the browser (the client only ever sees the
// finished chain JSON).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { verifyUser } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";
import { cached } from "@/lib/marketData/cache.server";
import { getRealizedVol } from "./volatility.server";
import { buildChain, type OptionChain } from "./chain.server";

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
