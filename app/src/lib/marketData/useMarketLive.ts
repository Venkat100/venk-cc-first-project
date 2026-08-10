// Client-side gate for live-price polling (PLAN.md §6 step 3). Two hard
// efficiency gates, both required before anything is allowed to poll:
//   1. Market hours — reuses the SAME isUsMarketOpen() the agent cron uses
//      (lib/marketData/marketHours.ts), so "is the market open" can never
//      disagree between the server's cron gate and the client's poll gate.
//   2. Visible tab — the Page Visibility API. A backgrounded tab must not
//      poll; this is the single biggest waste-saver, since most users leave
//      a trading app open in a background tab far more than they watch it.
// `isLive` = both true. Every live-updating query in the app (quotes, the
// 1D intraday chart) is gated on THIS, not on its own ad-hoc check, so the
// two gates can never be implemented inconsistently across call sites.

import { useEffect, useState } from "react";
import { isUsMarketOpen } from "./marketHours";

// Cheap to recompute (pure Intl call, no network) — only actually matters
// near the 9:30/16:00 ET boundary, so a coarse recheck interval is fine.
const MARKET_RECHECK_MS = 30_000;

function currentVisibility(): boolean {
  return typeof document === "undefined" ? true : document.visibilityState === "visible";
}

export function useMarketLive() {
  const [isOpen, setIsOpen] = useState(() => isUsMarketOpen());
  const [isTabVisible, setIsTabVisible] = useState(currentVisibility);

  useEffect(() => {
    const id = setInterval(() => setIsOpen(isUsMarketOpen()), MARKET_RECHECK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function onVisibilityChange() {
      setIsTabVisible(currentVisibility());
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return { isOpen, isTabVisible, isLive: isOpen && isTabVisible };
}
