import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkline } from "@/components/PriceChart";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { getWatchlist, addToWatchlist, removeFromWatchlist } from "@/lib/portfolio/queries";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { useSymbolSearch } from "@/lib/marketData/useSymbolSearch";
import { fmtUSD, fmtPct, sparkline } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { Star, Plus, X, Search, SearchX, Check } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/watchlist")({
  head: () => ({ meta: [{ title: "Watchlist · PaperTrader" }] }),
  component: Watchlist,
});

function Watchlist() {
  const qc = useQueryClient();
  const watchlistQ = useQuery({ queryKey: ["watchlist"], queryFn: getWatchlist });
  const symbols = (watchlistQ.data ?? []).map((w) => w.symbol);
  const quotesQ = useQuotes(symbols);
  const quotes = quotesQ.data;

  const [q, setQ] = useState("");
  const search = useSymbolSearch(q, 10);

  const addMut = useMutation({
    mutationFn: (symbol: string) => addToWatchlist(symbol),
    onSuccess: (_d, symbol) => {
      qc.invalidateQueries({ queryKey: ["watchlist"] });
      toast.success(`Added ${symbol}`);
    },
    onError: (e: Error) => toast.error(e.message || "Couldn't add ticker"),
  });

  const removeMut = useMutation({
    mutationFn: (symbol: string) => removeFromWatchlist(symbol),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["watchlist"] });
      toast("Removed from watchlist");
    },
    onError: (e: Error) => toast.error(e.message || "Couldn't remove ticker"),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <Star className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-sm text-muted-foreground">Tickers you're tracking. Click any to open its detail page.</p>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {watchlistQ.isLoading ? (
            <LoadingState label="Loading your watchlist…" />
          ) : watchlistQ.isError ? (
            <ErrorState message={(watchlistQ.error as Error)?.message} />
          ) : symbols.length === 0 ? (
            <EmptyState
              icon={Star}
              title="Your watchlist is empty"
              description="Search for any ticker below to start tracking it. Watched symbols also appear on your dashboard."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="py-3 font-medium text-right">Price</th>
                  <th className="py-3 font-medium text-right">Day</th>
                  <th className="py-3 font-medium">Trend</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {symbols.map((sym) => {
                  const r = quoteOf(quotes, sym);
                  const up = r.dayChangePct >= 0;
                  return (
                    <tr key={sym} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <Link to="/app/stock/$symbol" params={{ symbol: sym }} className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{r.symbol.slice(0, 2)}</div>
                          <div>
                            <div className="font-semibold">{r.symbol}</div>
                            <div className="text-xs text-muted-foreground">{r.name}</div>
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 text-right tabular">{fmtUSD(r.price)}</td>
                      <td className={cn("py-3 text-right tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(r.dayChangePct)}</td>
                      <td className="py-3"><Sparkline data={sparkline(sym)} up={up} width={120} height={32} /></td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => removeMut.mutate(sym)}
                          disabled={removeMut.isPending}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                          aria-label={`Remove ${sym}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Add via live search — any stock or ETF */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Add a ticker</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search any ticker — QQQ, VOO, NVDA, Apple…" className="h-7 border-0 bg-transparent p-0 focus-visible:ring-0" />
            {q && <button onClick={() => setQ("")} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>}
          </div>

          {!search.active ? (
            <p className="text-xs text-muted-foreground">Start typing a symbol or company name to find any stock or ETF.</p>
          ) : search.pending && search.matches.length === 0 ? (
            <LoadingState label={`Searching “${q}”…`} className="py-6" />
          ) : search.isError ? (
            <ErrorState message="Search is busy right now (rate limit). Try again in a moment." className="py-6" />
          ) : search.matches.length === 0 ? (
            <EmptyState icon={SearchX} title={`No tickers match “${q}”`} description="Try a symbol like QQQ, VOO, or NVDA." className="py-6" />
          ) : (
            <div className="divide-y divide-border/60 rounded-md border border-border">
              {search.matches.map((m) => {
                const have = symbols.includes(m.symbol);
                return (
                  <div key={m.symbol} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{m.symbol}</span>
                        {m.type && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{m.type}</span>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{m.name}</div>
                    </div>
                    {have ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5" /> Added</span>
                    ) : (
                      <Button size="sm" variant="outline" className="gap-1" disabled={addMut.isPending} onClick={() => addMut.mutate(m.symbol)}>
                        <Plus className="h-4 w-4" /> Add
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
