// One journal entry, rendered chronologically in the Journal page (and,
// filtered to one symbol, on the stock detail page). THE PAYOFF is the
// outcome line: pairing what the user said at the time with what actually
// happened since — computed by lib/journal/outcome.ts from data already on
// the page (no extra fetch here).

import { Pencil, Trash2, Receipt } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Delta } from "@/components/Delta";
import { fmtUSD } from "@/lib/mockData";
import type { JournalEntry } from "@/lib/supabase/types";
import type { JournalOutcome } from "@/lib/journal/outcome";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function OutcomeLine({ outcome }: { outcome: JournalOutcome }) {
  if (outcome.kind === "none") return null;

  if (outcome.kind === "stock") {
    if (outcome.side === "buy" && outcome.status === "open" && outcome.comparePrice != null && outcome.changePct != null) {
      return (
        <p className="text-sm">
          <span className="text-muted-foreground">Currently </span>
          <Delta value={outcome.changePct * 100} suffix="%" />
          <span className="text-muted-foreground"> since your {fmtUSD(outcome.entryPrice)} entry (now {fmtUSD(outcome.comparePrice)}).</span>
        </p>
      );
    }
    if (outcome.side === "buy" && outcome.status === "closed" && outcome.comparePrice != null && outcome.changePct != null) {
      return (
        <p className="text-sm text-muted-foreground">
          Position closed — last exit at {fmtUSD(outcome.comparePrice)} (
          <Delta value={outcome.changePct * 100} suffix="%" /> from your {fmtUSD(outcome.entryPrice)} entry){outcome.asOf ? ` on ${formatDate(outcome.asOf)}` : ""}.
        </p>
      );
    }
    if (outcome.side === "sell" && outcome.comparePrice != null && outcome.changePct != null) {
      return (
        <p className="text-sm text-muted-foreground">
          Since you sold at {fmtUSD(outcome.entryPrice)}, the stock is now {fmtUSD(outcome.comparePrice)} (
          <Delta value={outcome.changePct * 100} suffix="%" />).
        </p>
      );
    }
    return null;
  }

  // option
  if (outcome.side === "buy_to_open" && outcome.status === "open" && outcome.comparePremium != null && outcome.changePct != null) {
    return (
      <p className="text-sm">
        <span className="text-muted-foreground">This position is </span>
        <Delta value={outcome.changePct * 100} suffix="%" />
        <span className="text-muted-foreground"> since you opened at {fmtUSD(outcome.entryPremium)}/contract (now {fmtUSD(outcome.comparePremium)}).</span>
      </p>
    );
  }
  if (outcome.side === "buy_to_open" && (outcome.status === "closed" || outcome.status === "expired") && outcome.comparePremium != null) {
    return (
      <p className="text-sm text-muted-foreground">
        {outcome.status === "expired" ? "Expired worthless" : `Closed at ${fmtUSD(outcome.comparePremium)}/contract`}
        {outcome.changePct != null && (
          <>
            {" ("}
            <Delta value={outcome.changePct * 100} suffix="%" />
            {` from your ${fmtUSD(outcome.entryPremium)} entry)`}
          </>
        )}
        {outcome.asOf ? ` on ${formatDate(outcome.asOf)}` : ""}.
      </p>
    );
  }
  if (outcome.side === "sell_to_close") {
    return <p className="text-sm text-muted-foreground">You closed this position at {fmtUSD(outcome.entryPremium)}/contract.</p>;
  }
  return null;
}

export function JournalEntryCard({
  entry,
  outcome,
  tradeSummary,
  onEdit,
  onDelete,
}: {
  entry: JournalEntry;
  outcome: JournalOutcome;
  /** Plain-English trade context line, e.g. "Buy 5 NVDA @ $211.40" — shown for trade-linked entries. */
  tradeSummary?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isTradeLinked = !!(entry.transaction_id || entry.option_transaction_id);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{formatDate(entry.entry_date)}</span>
              {entry.symbol && <span className="rounded-md bg-surface px-1.5 py-0.5 font-semibold text-foreground">{entry.symbol}</span>}
              {isTradeLinked && (
                <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide">
                  <Receipt className="h-3 w-3" /> Trade note
                </span>
              )}
            </div>
            {tradeSummary && <p className="mt-1 text-sm font-medium text-foreground">{tradeSummary}</p>}
            {entry.title && <p className="mt-1 font-semibold">{entry.title}</p>}
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{entry.body}</p>
            <div className="mt-2">
              <OutcomeLine outcome={outcome} />
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onEdit} aria-label="Edit entry">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-[color:var(--color-loss)]" onClick={onDelete} aria-label="Delete entry">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
