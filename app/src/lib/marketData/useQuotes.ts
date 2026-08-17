import { useQuery } from "@tanstack/react-query";
import { getQuotes } from "./index";
import { useMarketLive } from "./useMarketLive";
import type { Quote } from "./types";

// Poll cadence vs. the server-side quote TTL (cache.server.ts's TTL.quote =
// 30s) — the arithmetic that makes live prices affordable:
//   Poll every 15s (this constant) against a 30s cache TTL ⇒ every OTHER
//   poll lands within the same still-fresh cache window, so a distinct
//   symbol costs AT MOST 1 provider call per 30s (2/min) — REGARDLESS of
//   how many browser tabs, users, or pages are polling that same symbol,
//   since they all read through the SAME server-side L1+L2 cache (PLAN.md
//   §6 step 2). Polling faster than the TTL doesn't reduce staleness (the
//   server would just serve the same cached value again) and polling
//   slower would leave the UI feeling static — 15s is the deliberate
//   midpoint. Gated by useMarketLive so this only ever fires during market
//   hours on a visible tab (see that file for why).
const QUOTE_POLL_MS = 15_000;

/**
 * Fetch live quotes for a set of symbols via the server function, keyed by
 * uppercase symbol. Auto-refreshes so prices stay live without hammering the
 * provider (server-side durable cache dedupes across every user watching the
 * same symbol — see cache.server.ts). Disabled when no symbols. Polling
 * stops entirely outside market hours or when the tab is backgrounded.
 */
export function useQuotes(symbols: string[]) {
  const list = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).sort();
  const { isLive } = useMarketLive();
  return useQuery<Map<string, Quote>>({
    queryKey: ["quotes", list.join(",")],
    queryFn: () => getQuotes(list),
    enabled: list.length > 0,
    staleTime: 15_000,
    refetchInterval: isLive ? QUOTE_POLL_MS : false,
  });
}

const ZERO: Quote = { symbol: "", name: "", sector: "—", ok: false, price: 0, dayChange: 0, dayChangePct: 0 };

/** Safe accessor: a quote from the map, or a zeroed placeholder. */
export function quoteOf(map: Map<string, Quote> | undefined, symbol: string): Quote {
  return map?.get(symbol.toUpperCase()) ?? { ...ZERO, symbol: symbol.toUpperCase(), name: symbol.toUpperCase() };
}
