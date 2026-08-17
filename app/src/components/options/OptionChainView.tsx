// The options chain browser: expiry selector + a strike-centered calls/puts
// table (classic broker layout — calls left, strike center, puts right),
// ATM strike anchored/scrolled-into-view, with the educational disclaimer +
// "What are options?" explainer up top.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOptionChain, type OptionContract, type OptionType } from "@/lib/options/queries";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { OptionsDisclaimer, OptionsExplainer } from "./OptionsExplainer";
import { formatCalendarDate } from "@/lib/format/datetime";
import { fmtUSD } from "@/lib/mockData";
import { cn } from "@/lib/utils";

export function OptionChainView({ symbol, onSelectContract }: { symbol: string; onSelectContract: (contract: OptionContract, side: OptionType) => void }) {
  const chainQ = useQuery({ queryKey: ["optionChain", symbol], queryFn: () => getOptionChain(symbol), staleTime: 5 * 60_000, retry: 1 });
  const [expiryIdx, setExpiryIdx] = useState(0);
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});

  const chain = chainQ.data;
  const expiry = chain?.expiries[expiryIdx];

  const atmIdx = useMemo(() => {
    if (!expiry || !chain) return -1;
    let idx = 0;
    for (let i = 1; i < expiry.strikes.length; i++) {
      if (Math.abs(expiry.strikes[i].strike - chain.spot) < Math.abs(expiry.strikes[idx].strike - chain.spot)) idx = i;
    }
    return idx;
  }, [expiry, chain]);

  useEffect(() => {
    if (atmIdx >= 0) rowRefs.current[atmIdx]?.scrollIntoView({ block: "center" });
  }, [atmIdx, expiryIdx]);

  return (
    <div className="space-y-4">
      <OptionsDisclaimer />
      <OptionsExplainer />

      {chainQ.isPending ? (
        <LoadingState label="Pricing the chain…" />
      ) : chainQ.isError ? (
        <div className="space-y-3">
          <ErrorState message={(chainQ.error as Error)?.message ?? "Couldn't generate an options chain right now."} />
          <div className="text-center"><button onClick={() => chainQ.refetch()} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">Try again</button></div>
        </div>
      ) : chain && expiry ? (
        <>
          <div>
            <p className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">Expiry</p>
            <div className="flex gap-1 overflow-x-auto pb-1">
              {chain.expiries.map((e, i) => (
                <button
                  key={e.expiry}
                  onClick={() => setExpiryIdx(i)}
                  className={cn(
                    "shrink-0 rounded-md px-3 py-2 text-xs font-medium tabular transition-colors sm:py-1.5",
                    i === expiryIdx ? "bg-primary text-primary-foreground" : "bg-surface text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {formatCalendarDate(e.expiry, { month: "short", day: "numeric" })}
                  <span className="ml-1 opacity-70">· {e.daysToExpiry}d</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border">
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2 border-b border-border bg-surface px-2 py-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:px-3">
              <span>Calls</span>
              <span className="px-4">Strike</span>
              <span>Puts</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {expiry.strikes.map((row, i) => {
                    const callItm = row.strike < chain.spot;
                    const putItm = row.strike > chain.spot;
                    const isAtm = i === atmIdx;
                    return (
                      <tr
                        key={row.strike}
                        ref={(el) => { rowRefs.current[i] = el; }}
                        className={cn("border-b border-border/60 last:border-0", isAtm && "ring-1 ring-inset ring-[color:var(--color-primary)]/50")}
                      >
                        <td className={cn("py-2 pl-2 text-left sm:pl-3", callItm && "bg-[color:var(--color-gain)]/5")}>
                          <button onClick={() => onSelectContract(row.call, "call")} className="w-full rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent sm:px-2">
                            <div className="tabular font-medium">{fmtUSD(row.call.premium)}</div>
                            <div className="hidden text-[10px] text-muted-foreground tabular md:block">Δ {row.call.delta.toFixed(2)}</div>
                          </button>
                        </td>
                        <td className={cn("px-2 text-center text-sm font-semibold tabular", isAtm && "text-[color:var(--color-primary)]")}>
                          {row.strike}
                        </td>
                        <td className={cn("py-2 pr-2 text-right sm:pr-3", putItm && "bg-[color:var(--color-loss)]/5")}>
                          <button onClick={() => onSelectContract(row.put, "put")} className="w-full rounded-md px-1.5 py-1.5 text-right transition-colors hover:bg-accent sm:px-2">
                            <div className="tabular font-medium">{fmtUSD(row.put.premium)}</div>
                            <div className="hidden text-[10px] text-muted-foreground tabular md:block">Δ {row.put.delta.toFixed(2)}</div>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Spot ${chain.spot} · realized vol {(chain.vol * 100).toFixed(1)}% · tap a premium to trade. Shaded cells are in-the-money; the highlighted row is the strike closest to the current price.
          </p>
        </>
      ) : null}
    </div>
  );
}
