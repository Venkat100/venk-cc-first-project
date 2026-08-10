// Subtle "Market closed" indicator (PLAN.md §6 step 3) — shown wherever a
// live price is displayed so it's clear the number on screen is the last
// close, not something updating right now. Deliberately quiet (no red/alert
// styling — a closed market is normal, not an error) and renders NOTHING
// when the market is open, so it never adds visual noise during the case
// that matters most (someone actively watching a live price).

import { useMarketLive } from "@/lib/marketData/useMarketLive";
import { cn } from "@/lib/utils";
import { CircleDot } from "lucide-react";

export function MarketStatusBadge({ className }: { className?: string }) {
  const { isOpen } = useMarketLive();
  if (isOpen) return null;
  return (
    <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <CircleDot className="h-3 w-3" />
      <span>Market closed — showing last close</span>
    </div>
  );
}
