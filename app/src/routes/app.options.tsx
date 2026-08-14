// Global Options page (PLAN.md §6 step 4 — discoverability). Options were
// previously only reachable as a tab buried on Stock Detail; this gives them
// a dedicated home, the same way Margin got one in M2. Reuses every existing
// O1–O4 component/query wholesale (OptionPositionsList, OptionChainView,
// OptionOrderPanel, OptionsExplainer, getOptionPositions) — no duplicated
// logic. getOptionPositions() already returns ALL of the user's positions
// across every symbol (the same query Dashboard/Portfolio/Stock Detail read),
// so no new server function was needed for the positions half of this page.

import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { MarketStatusBadge } from "@/components/MarketStatusBadge";
import { OptionPositionsList } from "@/components/options/OptionPositionsList";
import { OptionChainView } from "@/components/options/OptionChainView";
import { OptionOrderPanel, type OrderPanelState } from "@/components/options/OptionOrderPanel";
import { OptionsExplainer } from "@/components/options/OptionsExplainer";
import { UnlockGate } from "@/components/coaching/UnlockGate";
import { getOptionPositions } from "@/lib/options/queries";
import { useSymbolSearch } from "@/lib/marketData/useSymbolSearch";
import { fmtUSD } from "@/lib/mockData";
import { SplitSquareHorizontal, Search, SearchX, X } from "lucide-react";

export const Route = createFileRoute("/app/options")({
  head: () => ({ meta: [{ title: "Options · My PaperTrader" }] }),
  // Lets Markets deep-link straight into a symbol's chain (?symbol=NVDA)
  // instead of landing a user on an empty search box.
  validateSearch: (search: Record<string, unknown>) => ({
    symbol: typeof search.symbol === "string" && search.symbol.trim() ? search.symbol.trim().toUpperCase() : undefined,
  }),
  component: OptionsPage,
});

function OptionsPage() {
  const { symbol: linkedSymbol } = Route.useSearch();

  // Same ["optionPositions"] query key Dashboard/Portfolio/Stock Detail all
  // read — shares the cache, can never disagree on a position's value.
  const positionsQ = useQuery({ queryKey: ["optionPositions"], queryFn: getOptionPositions });
  const positions = positionsQ.data ?? [];
  const totalValue = useMemo(() => positions.reduce((sum, p) => sum + p.marketValue, 0), [positions]);

  const [orderPanel, setOrderPanel] = useState<OrderPanelState>({ open: false });
  const [selectedSymbol, setSelectedSymbol] = useState<string | undefined>(linkedSymbol);
  const [q, setQ] = useState("");
  const search = useSymbolSearch(q, 10);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <SplitSquareHorizontal className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Options</h1>
          <p className="text-sm text-muted-foreground">Your positions across every symbol, and a chain browser to trade any stock or ETF.</p>
          <MarketStatusBadge className="mt-1" />
        </div>
      </div>

      <UnlockGate feature="options">
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Your positions</CardTitle>
                {positions.length > 0 && <span className="text-xs tabular text-muted-foreground">Total value {fmtUSD(totalValue)}</span>}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {positionsQ.isLoading ? (
                <LoadingState label="Pricing your option positions…" />
              ) : positionsQ.isError ? (
                <ErrorState message={(positionsQ.error as Error)?.message} />
              ) : positions.length === 0 ? (
                <EmptyState
                  icon={SplitSquareHorizontal}
                  title="You don't hold any options yet"
                  description="A call gives you the right to buy 100 shares at a fixed price before it expires; a put, the right to sell. Browse a chain below to place your first paper trade."
                  action={<div className="w-full max-w-md text-left"><OptionsExplainer /></div>}
                />
              ) : (
                <OptionPositionsList positions={positions} onSell={(p) => setOrderPanel({ open: true, mode: "sell", position: p })} showSymbolLink />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Browse chains</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {selectedSymbol ? (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{selectedSymbol}</p>
                    <button
                      onClick={() => { setSelectedSymbol(undefined); setQ(""); }}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" /> Change symbol
                    </button>
                  </div>
                  <OptionChainView symbol={selectedSymbol} onSelectContract={(contract, side) => setOrderPanel({ open: true, mode: "buy", contract, side })} />
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <Input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search any ticker — AAPL, QQQ, VOO, Tesla…"
                      className="h-7 border-0 bg-transparent p-0 focus-visible:ring-0"
                    />
                    {q && <button onClick={() => setQ("")} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>}
                  </div>

                  {!search.active ? (
                    <p className="text-xs text-muted-foreground">Start typing a symbol or company name to browse its option chain.</p>
                  ) : search.pending && search.matches.length === 0 ? (
                    <LoadingState label={`Searching "${q}"…`} className="py-6" />
                  ) : search.isError ? (
                    <ErrorState message="Search is busy right now (rate limit). Try again in a moment." className="py-6" />
                  ) : search.matches.length === 0 ? (
                    <EmptyState icon={SearchX} title={`No tickers match "${q}"`} description="Try a symbol like AAPL, QQQ, VOO, or a company name." className="py-6" />
                  ) : (
                    <div className="divide-y divide-border/60 rounded-md border border-border">
                      {search.matches.map((m) => (
                        <button
                          key={m.symbol}
                          onClick={() => setSelectedSymbol(m.symbol)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-accent"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">{m.symbol}</span>
                              {m.type && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{m.type}</span>}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">{m.name}</div>
                          </div>
                          <span className="shrink-0 text-xs text-[color:var(--color-primary)]">View chain →</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <OptionOrderPanel state={orderPanel} onClose={() => setOrderPanel({ open: false })} />
        </div>
      </UnlockGate>
    </div>
  );
}
