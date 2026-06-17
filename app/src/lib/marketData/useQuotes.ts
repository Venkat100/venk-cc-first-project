import { useQuery } from "@tanstack/react-query";
import { getQuotes } from "./index";
import type { Quote } from "./types";

/**
 * Fetch live quotes for a set of symbols via the server function, keyed by
 * uppercase symbol. Auto-refreshes so prices stay fresh-ish without hammering
 * the provider (server-side cache also dedupes). Disabled when no symbols.
 */
export function useQuotes(symbols: string[]) {
  const list = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).sort();
  return useQuery<Map<string, Quote>>({
    queryKey: ["quotes", list.join(",")],
    queryFn: () => getQuotes(list),
    enabled: list.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

const ZERO: Quote = { symbol: "", name: "", sector: "—", price: 0, dayChange: 0, dayChangePct: 0 };

/** Safe accessor: a quote from the map, or a zeroed placeholder. */
export function quoteOf(map: Map<string, Quote> | undefined, symbol: string): Quote {
  return map?.get(symbol.toUpperCase()) ?? { ...ZERO, symbol: symbol.toUpperCase(), name: symbol.toUpperCase() };
}
