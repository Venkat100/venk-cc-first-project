// Educational framing shared across the options UI: a prominent disclaimer
// (premiums are model-estimated, not live market quotes) and a collapsible
// beginner-tone "What are options?" explainer.

import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export function OptionsDisclaimer() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-3 py-2.5 text-xs text-foreground sm:text-sm">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning,#d97706)]" />
      <p>
        <span className="font-semibold">Premiums are model-estimated</span> (Black-Scholes from live prices + realized volatility), not live market quotes. Educational simulation — not financial advice.
      </p>
    </div>
  );
}

export function OptionsExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-foreground sm:py-2">
        What are options?
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 border-t border-border px-3 py-3 text-sm text-muted-foreground">
        <p>
          A <span className="text-foreground font-medium">call</span> gives you the right (not the obligation) to buy 100 shares at a fixed <span className="text-foreground font-medium">strike</span> price before it <span className="text-foreground font-medium">expires</span> — you'd want one if you think the stock is going up. A <span className="text-foreground font-medium">put</span> is the mirror image: the right to sell at the strike, useful if you think the stock is going down.
        </p>
        <p>
          The price you pay is the <span className="text-foreground font-medium">premium</span>, quoted per share — but one contract always covers 100 shares, so buying 1 contract at a $4.78 premium costs $478.00 ($4.78 × 100). That's the most you can lose on a long option.
        </p>
        <p>
          Options are a <span className="text-foreground font-medium">decaying asset</span>: the closer you get to expiry, the less time value they carry, and a contract that finishes out-of-the-money (the wrong side of the strike) expires <span className="text-foreground font-medium">worthless</span> — a complete loss of the premium paid. This simulator lets you feel that risk with zero real money on the line.
        </p>
        <p>
          If you don't sell before expiry, we don't leave it hanging: at expiration every position is automatically <span className="text-foreground font-medium">cash-settled</span> — in-the-money contracts are credited their intrinsic value (no shares change hands), and out-of-the-money contracts simply expire worthless. You'll always see it labeled clearly in your activity — "Settled $X" or "Expired worthless."
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
