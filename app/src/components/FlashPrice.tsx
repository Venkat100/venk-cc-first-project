// Thin wrapper that applies the tick-flash background (styles.css's
// .price-flash-up/-down) to whatever's inside it, comparing `value` across
// renders. Generic over markup (span/td-safe) so table cells and inline
// price text can both use it without each call site re-deriving its own
// flash state.

import { useTickFlash } from "@/lib/marketData/useTickFlash";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function FlashPrice({ value, className, children }: { value: number | undefined; className?: string; children: ReactNode }) {
  const flash = useTickFlash(value);
  return <span className={cn("rounded", className, flash)}>{children}</span>;
}
