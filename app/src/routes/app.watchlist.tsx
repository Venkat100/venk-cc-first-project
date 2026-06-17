import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkline } from "@/components/PriceChart";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { getWatchlist, addToWatchlist, removeFromWatchlist } from "@/lib/portfolio/queries";
import { getQuote } from "@/lib/marketData";
import { STOCKS, fmtUSD, fmtPct, sparkline } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { Star, Plus, X } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/watchlist")({
  head: () => ({ meta: [{ title: "Watchlist · PaperTrader" }] }),
  component: Watchlist,
});

function Watchlist() {
  const qc = useQueryClient();
  const watchlistQ = useQuery({ queryKey: ["watchlist"], queryFn: getWatchlist });
  const symbols = (watchlistQ.data ?? []).map((w) => w.symbol);

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

  // Selectable universe = mock stocks not already tracked. (Real symbol search
  // arrives with live market data in Phase 5.)
  const available = STOCKS.filter((s) => !symbols.includes(s.symbol));

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
              description="Add a ticker below to start tracking it. Watched symbols also appear on your dashboard."
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
                  const q = getQuote(sym);
                  const up = q.dayChangePct >= 0;
                  return (
                    <tr key={sym} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <Link to="/app/stock/$symbol" params={{ symbol: sym }} className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{q.symbol.slice(0, 2)}</div>
                          <div>
                            <div className="font-semibold">{q.symbol}</div>
                            <div className="text-xs text-muted-foreground">{q.name}</div>
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 text-right tabular">{fmtUSD(q.price)}</td>
                      <td className={cn("py-3 text-right tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(q.dayChangePct)}</td>
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

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Add tickers</CardTitle></CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          {available.map((s) => (
            <Button
              key={s.symbol}
              variant="outline"
              className="justify-between gap-2"
              disabled={addMut.isPending}
              onClick={() => addMut.mutate(s.symbol)}
            >
              <span className="flex items-center gap-2"><span className="font-semibold">{s.symbol}</span><span className="text-xs text-muted-foreground truncate">{s.name}</span></span>
              <Plus className="h-4 w-4" />
            </Button>
          ))}
          {available.length === 0 && <p className="text-sm text-muted-foreground">You're tracking everything available.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
