import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sparkline } from "@/components/PriceChart";
import { WatchlistStar } from "@/components/WatchlistStar";
import { ContentIndicator } from "@/components/ContentIndicator";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { FlashPrice } from "@/components/FlashPrice";
import { MarketStatusBadge } from "@/components/MarketStatusBadge";
import { MARKET_UNIVERSE } from "@/lib/marketData";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { useContentAvailability } from "@/lib/marketData/useContentAvailability";
import { useSymbolSearch } from "@/lib/marketData/useSymbolSearch";
import { getStock, fmtUSD, fmtPct, sparkline } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { Search, SearchX, SplitSquareHorizontal } from "lucide-react";

export const Route = createFileRoute("/app/markets")({
  head: () => ({ meta: [{ title: "Markets · My PaperTrader" }] }),
  component: Markets,
});

function Markets() {
  const universe = MARKET_UNIVERSE as readonly string[];
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("All");
  const [tab, setTab] = useState<"all" | "trending">("all");

  // Live symbol search (debounced, Finnhub) — finds ANY stock/ETF.
  const search = useSymbolSearch(q, 12);
  const active = search.active;

  // One quote fetch for whichever set is on screen (search matches or Popular).
  const quoteSymbols = active ? search.matches.map((m) => m.symbol) : [...universe];
  const quotesQ = useQuotes(quoteSymbols);
  const quotes = quotesQ.data;
  const availabilityQ = useContentAvailability(quoteSymbols);
  const newsSet = new Set(availabilityQ.data?.newsSymbols ?? []);
  const insightSet = new Set(availabilityQ.data?.insightSymbols ?? []);

  const sectors = useMemo(
    () => ["All", ...Array.from(new Set(universe.map((s) => getStock(s)?.sector ?? "—")))],
    [universe],
  );

  const popularRows = useMemo(() => {
    let xs = universe.map((sym) => quoteOf(quotes, sym));
    if (sector !== "All") xs = xs.filter((r) => r.sector === sector);
    if (tab === "trending") xs = [...xs].sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct));
    return xs;
  }, [universe, quotes, sector, tab]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Markets</h1>
          <p className="text-sm text-muted-foreground">Search any stock or ETF — prices are live.</p>
          <MarketStatusBadge className="mt-1" />
        </div>
        {!active && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface p-1">
            {(["all", "trending"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn("rounded px-3 py-1 text-xs font-medium capitalize", tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>{t}</button>
            ))}
          </div>
        )}
      </div>

      {/* Search + (Popular-only) sector filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any ticker — AAPL, QQQ, VOO, Tesla…" className="h-7 border-0 bg-transparent p-0 focus-visible:ring-0" />
              {q && <button onClick={() => setQ("")} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>}
            </div>
            {!active && (
              <div className="flex flex-wrap gap-1">
                {sectors.map((s) => (
                  <button key={s} onClick={() => setSector(s)} className={cn("rounded-full border px-3 py-1 text-xs", sector === s ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>{s}</button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          {!active && (
            <div className="px-4 pt-3 text-xs uppercase tracking-wider text-muted-foreground">Popular</div>
          )}

          {active && search.pending && search.matches.length === 0 ? (
            <LoadingState label={`Searching “${q}”…`} />
          ) : active && search.isError ? (
            <ErrorState message="Search is busy right now (rate limit). Try again in a moment." />
          ) : active && search.matches.length === 0 ? (
            <EmptyState icon={SearchX} title={`No tickers match “${q}”`} description="Try a symbol like AAPL, QQQ, VOO, or a company name." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="hidden py-3 font-medium sm:table-cell">{active ? "Type" : "Sector"}</th>
                  <th className="py-3 font-medium text-right">Price</th>
                  <th className="py-3 font-medium text-right">Change</th>
                  {!active && <th className="hidden py-3 font-medium md:table-cell">Trend</th>}
                  <th className="px-4 py-3 font-medium text-right">Trade</th>
                </tr>
              </thead>
              <tbody>
                {active
                  ? search.matches.map((m) => {
                      const r = quoteOf(quotes, m.symbol);
                      const name = r.name && r.name !== r.symbol ? r.name : m.name || m.symbol;
                      const up = r.dayChangePct >= 0;
                      const priced = !quotesQ.isLoading;
                      return (
                        <tr key={m.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                          <td className="px-2 py-3 sm:px-4">
                            <Link to="/app/stock/$symbol" params={{ symbol: m.symbol }} className="flex min-w-0 items-center gap-2 sm:gap-3">
                              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{m.symbol.slice(0, 2)}</div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-semibold">{m.symbol}</span>
                                  <ContentIndicator hasNews={newsSet.has(m.symbol)} hasInsight={insightSet.has(m.symbol)} />
                                </div>
                                <div className="max-w-[90px] truncate text-xs text-muted-foreground sm:max-w-[260px]">{name}</div>
                              </div>
                            </Link>
                          </td>
                          <td className="hidden py-3 text-xs text-muted-foreground sm:table-cell">{m.type || r.sector}</td>
                          <td className="py-3 text-right tabular">
                            {priced ? <FlashPrice value={r.price} className="px-1">{fmtUSD(r.price)}</FlashPrice> : "…"}
                          </td>
                          <td className={cn("py-3 text-right tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                            {priced ? <>{up ? "+" : "−"}{fmtUSD(Math.abs(r.dayChange))} <span className="hidden text-xs opacity-80 sm:inline">({fmtPct(r.dayChangePct)})</span></> : "…"}
                          </td>
                          <td className="px-2 py-3 sm:px-4">
                            <div className="flex items-center justify-end gap-1">
                              <WatchlistStar symbol={m.symbol} />
                              <Link
                                to="/app/options"
                                search={{ symbol: m.symbol }}
                                aria-label={`View ${m.symbol}'s option chain`}
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              >
                                <SplitSquareHorizontal className="h-4 w-4" />
                              </Link>
                              <Link to="/app/stock/$symbol" params={{ symbol: m.symbol }}><Button size="sm" variant="outline">Trade</Button></Link>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  : popularRows.map((r) => {
                      const up = r.dayChangePct >= 0;
                      return (
                        <tr key={r.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                          <td className="px-2 py-3 sm:px-4">
                            <Link to="/app/stock/$symbol" params={{ symbol: r.symbol }} className="flex min-w-0 items-center gap-2 sm:gap-3">
                              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{r.symbol.slice(0, 2)}</div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-semibold">{r.symbol}</span>
                                  <ContentIndicator hasNews={newsSet.has(r.symbol)} hasInsight={insightSet.has(r.symbol)} />
                                </div>
                                <div className="max-w-[90px] truncate text-xs text-muted-foreground sm:max-w-none">{r.name}</div>
                              </div>
                            </Link>
                          </td>
                          <td className="hidden py-3 text-xs text-muted-foreground sm:table-cell">{r.sector}</td>
                          <td className="py-3 text-right tabular"><FlashPrice value={r.price} className="px-1">{fmtUSD(r.price)}</FlashPrice></td>
                          <td className={cn("py-3 text-right tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                            {up ? "+" : "−"}{fmtUSD(Math.abs(r.dayChange))} <span className="hidden text-xs opacity-80 sm:inline">({fmtPct(r.dayChangePct)})</span>
                          </td>
                          {/* TODO: real sparklines need a batch intraday source; mock trend for now. */}
                          <td className="hidden py-3 md:table-cell"><Sparkline data={sparkline(r.symbol)} up={up} width={96} height={28} /></td>
                          <td className="px-2 py-3 sm:px-4">
                            <div className="flex items-center justify-end gap-1">
                              <WatchlistStar symbol={r.symbol} />
                              <Link
                                to="/app/options"
                                search={{ symbol: r.symbol }}
                                aria-label={`View ${r.symbol}'s option chain`}
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              >
                                <SplitSquareHorizontal className="h-4 w-4" />
                              </Link>
                              <Link to="/app/stock/$symbol" params={{ symbol: r.symbol }}><Button size="sm" variant="outline">Trade</Button></Link>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
