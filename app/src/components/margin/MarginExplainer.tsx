// Educational framing for margin (M2) — a prominent simulation disclaimer
// plus a collapsible beginner-tone "What is margin?" explainer. Deliberately
// honest and a little sobering: this is the feature where naive users get
// hurt with real money in real life, so the copy doesn't undersell the risk.
// Same visual pattern as components/options/OptionsExplainer.tsx (O3) —
// consistent look across the two riskiest features in the app.

import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export function MarginDisclaimer() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-3 py-2.5 text-xs text-foreground sm:text-sm">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-warning,#d97706)]" />
      <p>
        <span className="font-semibold">Educational simulation.</span> Margin lets you borrow virtual money to buy more than your cash alone allows — it can amplify gains, but it amplifies losses the same way, and a bad move can force an automatic sale at the worst possible time. No real money is ever at risk here.
      </p>
    </div>
  );
}

export function MarginExplainer({ interestRatePct, maintenancePct, warningBufferPct }: { interestRatePct: number; maintenancePct: number; warningBufferPct: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-foreground sm:py-2">
        What is margin?
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 border-t border-border px-3 py-3 text-sm text-muted-foreground">
        <p>
          Buying <span className="text-foreground font-medium">"on margin"</span> means borrowing money from your account to buy more than your own cash covers. Here, that means borrowing virtual money against your own virtual holdings — up to <span className="text-foreground font-medium">2× your equity</span>, a simplified version of how real brokers extend credit.
        </p>
        <p>
          The catch: borrowing to invest is <span className="text-foreground font-medium">leverage</span>, and leverage cuts both ways. If your positions go up, your gains are bigger than if you'd only used your own cash. If they go down, your <span className="text-foreground font-medium">losses are bigger too</span> — and you still owe the loan regardless of which way it went. This is the single most important thing to understand before turning it on.
        </p>
        <p>
          To protect against the loan exceeding what your positions are worth, every account keeps a <span className="text-foreground font-medium">maintenance requirement</span>: your equity (what you'd have left after paying off the loan) must stay above {maintenancePct.toFixed(0)}% of your positions' value at all times.
        </p>
        <p>
          If equity falls below that line, it's a <span className="text-foreground font-medium">margin call</span> — and unlike a lot of "calls," nothing needs to ring: the system automatically sells your largest position (and more, if needed) to bring equity back above the requirement. This can happen at a bad price, at a bad time, without you doing anything wrong except being overextended when the market moved. You'll get a <span className="text-foreground font-medium">warning</span> first, when equity drifts within {(warningBufferPct * 100).toFixed(0)}% of the requirement — a heads-up before it becomes a forced sale.
        </p>
        <p>
          Borrowing isn't free: interest accrues <span className="text-foreground font-medium">every day</span> on your outstanding loan, at a simulated {(interestRatePct * 100).toFixed(0)}% annual rate, and gets added to the loan itself — so an unpaid loan slowly grows on its own, even if you never trade again.
        </p>
        <p>
          This simulator lets you experience all of that — the leverage, the interest, and yes, a real margin call — with zero real money on the line. That's the point: it's a safe place to find out what "overextended" actually feels like before it happens with money that matters.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
