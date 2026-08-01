// Reusable option-positions table — used both on the Stock Detail Options
// tab (pre-filtered to that symbol) and the Portfolio page (all symbols).
// Same responsive column-priority pattern as every other table in the app
// (R4 convention): identity/value/P&L always visible, secondary columns
// hidden below their breakpoint rather than forcing horizontal scroll.

import { Link } from "@tanstack/react-router";
import { fmtUSD, fmtPct } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import type { EnrichedOptionPosition } from "@/lib/options/queries";
import { EmptyState } from "@/components/DataStates";
import { LineChart } from "lucide-react";

export function OptionPositionsList({
  positions,
  onSell,
  showSymbolLink = false,
  emptyTitle = "No option positions yet",
  emptyDescription = "Buy a call or put from a stock's Options tab to see it here.",
}: {
  positions: EnrichedOptionPosition[];
  onSell: (p: EnrichedOptionPosition) => void;
  showSymbolLink?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (positions.length === 0) {
    return <EmptyState icon={LineChart} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-3 font-medium">Contract</th>
            <th className="hidden py-3 font-medium text-right sm:table-cell">Contracts</th>
            <th className="hidden py-3 font-medium text-right lg:table-cell">Avg premium</th>
            <th className="hidden py-3 font-medium text-right md:table-cell">Current</th>
            <th className="py-3 font-medium text-right">Market value</th>
            <th className="py-3 font-medium text-right">P&L</th>
            <th className="hidden py-3 font-medium text-right sm:table-cell">Expires</th>
            <th className="px-4 py-3 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const up = p.unrealizedPL >= 0;
            const label = `${p.symbol} $${p.strike} ${p.optType === "call" ? "Call" : "Put"}`;
            return (
              <tr key={p.id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-3">
                  {showSymbolLink ? (
                    <Link to="/app/stock/$symbol" params={{ symbol: p.symbol }} className="font-semibold hover:underline">{label}</Link>
                  ) : (
                    <span className="font-semibold">{label}</span>
                  )}
                  <div className="text-xs text-muted-foreground">{expiryLabel(p.expiry)}</div>
                </td>
                <td className="hidden py-3 text-right tabular sm:table-cell">{p.contracts}</td>
                <td className="hidden py-3 text-right tabular lg:table-cell">{fmtUSD(p.avgPremium)}</td>
                <td className="hidden py-3 text-right tabular md:table-cell">{fmtUSD(p.currentPremium)}</td>
                <td className="py-3 text-right tabular">{fmtUSD(p.marketValue)}</td>
                <td className={cn("py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                  {up ? "+" : "−"}{fmtUSD(Math.abs(p.unrealizedPL))} <span className="hidden text-xs opacity-80 sm:inline">({fmtPct(p.unrealizedPLPct)})</span>
                </td>
                <td className="hidden py-3 text-right tabular text-muted-foreground sm:table-cell">{p.daysToExpiry}d</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => onSell(p)} className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent">Sell</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function expiryLabel(expiry: string): string {
  return new Date(`${expiry}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
