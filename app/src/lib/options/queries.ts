// Client-side read helpers for options — chain browsing + the signed-in
// user's live-priced positions. Mirrors lib/insights/api.ts / lib/portfolio/queries.ts.

import { supabase } from "@/lib/supabase/client";
import { getOptionChainFn, getOptionPositionsFn } from "./functions";
import type { OptionChain } from "./chain.server";
import type { EnrichedOptionPosition } from "./valuation.server";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

/** Generated option chain for a symbol (server-priced, ~1hr cached). */
export async function getOptionChain(symbol: string): Promise<OptionChain> {
  const res = await getOptionChainFn({ data: { accessToken: await token(), symbol: symbol.toUpperCase() } });
  if (!res.ok) throw new Error(res.error);
  return res.chain;
}

/** ALL of the signed-in user's option positions, live-priced. Dashboard,
 *  Portfolio, and Stock Detail's Options tab all read this ONE query. */
export async function getOptionPositions(): Promise<EnrichedOptionPosition[]> {
  const res = await getOptionPositionsFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return res.positions;
}

export type { OptionChain, OptionExpiry, StrikeRow, OptionContract } from "./chain.server";
export type { EnrichedOptionPosition } from "./valuation.server";
export type { OptionType } from "./blackscholes";
