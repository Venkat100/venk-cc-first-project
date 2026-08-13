import { useQuery } from "@tanstack/react-query";
import { getContentAvailability } from "./index";

// A slow-moving signal (news/insight rows change at most a few times a day
// per symbol, not every 15s like quotes) — no live polling, just a plain
// fetch-once-per-mount, matching its own 24h/1-day freshness windows
// server-side (see functions.ts's getContentAvailabilityFn).
export function useContentAvailability(symbols: string[]) {
  const list = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).sort();
  return useQuery({
    queryKey: ["contentAvailability", list.join(",")],
    queryFn: () => getContentAvailability(list),
    enabled: list.length > 0,
    staleTime: 5 * 60_000,
  });
}
