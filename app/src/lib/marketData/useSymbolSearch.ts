import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchSymbols } from "./index";
import type { SymbolMatch } from "./types";

/** Returns `value` only after it has stopped changing for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Debounced live symbol search (Finnhub via searchSymbols). Results are cached
 * for an hour server-side, and the debounce keeps us well under the rate limit.
 */
export function useSymbolSearch(query: string, maxResults = 10) {
  const q = query.trim();
  const debounced = useDebouncedValue(q, 350);
  const active = debounced.length >= 1;

  const res = useQuery<SymbolMatch[]>({
    queryKey: ["symbolSearch", debounced.toUpperCase()],
    queryFn: () => searchSymbols(debounced),
    enabled: active,
    staleTime: 60 * 60_000,
    retry: 1,
  });

  return {
    active, // a (debounced) query is in effect
    pending: q.length >= 1 && (q !== debounced || res.isFetching), // typing or fetching
    isError: res.isError,
    error: res.error as Error | undefined,
    matches: (res.data ?? []).slice(0, maxResults),
  };
}
