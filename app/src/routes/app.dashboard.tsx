import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PriceChart, Sparkline } from "@/components/PriceChart";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { getHoldings, getWatchlist } from "@/lib/portfolio/queries";
import { getQuote } from "@/lib/marketData";
import { useAuth } from "@/lib/auth/auth-context";
import { topMovers, fmtUSD, fmtPct, sparkline } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, Star, Wallet, LineChart } from "lucide-react";

export const Route = createFileRoute("/app/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard · PaperTrader" }],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { profile } = useAuth();
  const cash = profile?.cash_balance ?? 0;

  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: getHoldings });
  const watchlistQ = useQuery({ queryKey: ["watchlist"], queryFn: getWatchlist });

  const holdings = holdingsQ.data ?? [];

  // Prices come from the marketData stub (Phase 5 swap point) — never directly.
  let holdingsValue = 0;
  let dayAbs = 0;
  let dayBaseline = 0;
  let costBasis = 0;
  for (const h of holdings) {
    const q = getQuote(h.symbol);
    holdingsValue += q.price * h.quantity;
    dayAbs += q.dayChange * h.quantity;
    dayBaseline += (q.price - q.dayChange) * h.quantity;
    costBasis += h.avg_cost * h.quantity;
  }
  const total = cash + holdingsValue;
  const dayPct = dayBaseline > 0 ? (dayAbs / dayBaseline) * 100 : 0;
  const retAbs = holdingsValue - costBasis;
  const retPct = costBasis > 0 ? (retAbs / costBasis) * 100 : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Good to see you back</h1>
        <p className="text-sm text-muted-foreground">Here's where your paper portfolio stands today.</p>
      </div>

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Portfolio value" value={fmtUSD(total)} sub={`${holdings.length} holding${holdings.length === 1 ? "" : "s"}`} />
        <Stat label="Buying power" value={fmtUSD(cash)} sub="Virtual cash available" />
        <Stat label="Today's change" value={`${dayAbs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(dayAbs))}`} sub={fmtPct(dayPct)} tone={dayAbs >= 0 ? "gain" : "loss"} />
        <Stat label="Total return" value={`${retAbs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(retAbs))}`} sub={fmtPct(retPct)} tone={retAbs >= 0 ? "gain" : "loss"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main chart + holdings */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-end justify-between">
                <div>
                  <CardTitle className="text-base font-medium text-muted-foreground">Portfolio value</CardTitle>
                  <p className="mt-1 text-3xl font-semibold tabular">{fmtUSD(total)}</p>
                  <p className={cn("mt-1 text-sm tabular", dayAbs >= 0 ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                    {dayAbs >= 0 ? "+" : "−"}{fmtUSD(Math.abs(dayAbs))} ({fmtPct(dayPct)}) today
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {holdings.length > 0 ? (
                // NOTE: series is still placeholder — real portfolio history
                // arrives with portfolio_snapshots in Phase 8.
                <PriceChart symbol="AAPL" endPrice={total} height={300} defaultRange="3M" />
              ) : (
                <EmptyState
                  icon={LineChart}
                  title="Your portfolio chart will appear here"
                  description="Once you hold positions, your portfolio value over time shows up in this space."
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Holdings</CardTitle>
                <Link to="/app/portfolio" className="text-xs text-muted-foreground hover:text-foreground">View all →</Link>
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {holdingsQ.isLoading ? (
                <LoadingState label="Loading your holdings…" />
              ) : holdingsQ.isError ? (
                <ErrorState message={(holdingsQ.error as Error)?.message} />
              ) : holdings.length === 0 ? (
                <EmptyState
                  icon={Wallet}
                  title="No holdings yet"
                  description="Start trading to build your portfolio — your positions will show up here."
                  action={
                    <Link to="/app/markets" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
                      Browse markets
                    </Link>
                  }
                />
              ) : (
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 font-medium">Symbol</th>
                      <th className="py-2 font-medium">Shares</th>
                      <th className="py-2 font-medium text-right">Avg cost</th>
                      <th className="py-2 font-medium text-right">Price</th>
                      <th className="py-2 font-medium text-right">Market value</th>
                      <th className="py-2 font-medium text-right">Unrealized P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => {
                      const q = getQuote(h.symbol);
                      const mv = q.price * h.quantity;
                      const pl = (q.price - h.avg_cost) * h.quantity;
                      const plPct = h.avg_cost > 0 ? ((q.price - h.avg_cost) / h.avg_cost) * 100 : 0;
                      const up = pl >= 0;
                      return (
                        <tr key={h.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                          <td className="py-3">
                            <Link to="/app/stock/$symbol" params={{ symbol: q.symbol }} className="flex items-center gap-3">
                              <div className="grid h-8 w-8 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{q.symbol.slice(0, 2)}</div>
                              <div>
                                <div className="font-semibold">{q.symbol}</div>
                                <div className="text-xs text-muted-foreground">{q.name}</div>
                              </div>
                            </Link>
                          </td>
                          <td className="py-3 tabular">{h.quantity}</td>
                          <td className="py-3 text-right tabular">{fmtUSD(h.avg_cost)}</td>
                          <td className="py-3 text-right tabular">{fmtUSD(q.price)}</td>
                          <td className="py-3 text-right tabular">{fmtUSD(mv)}</td>
                          <td className={cn("py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                            {up ? "+" : "−"}{fmtUSD(Math.abs(pl))} <span className="text-xs opacity-80">({fmtPct(plPct)})</span>
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

        {/* Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Star className="h-4 w-4" /> Watchlist</CardTitle>
                <Link to="/app/watchlist" className="text-xs text-muted-foreground hover:text-foreground">All →</Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              {watchlistQ.isLoading ? (
                <LoadingState label="Loading…" />
              ) : watchlistQ.isError ? (
                <ErrorState message={(watchlistQ.error as Error)?.message} />
              ) : (watchlistQ.data ?? []).length === 0 ? (
                <EmptyState
                  icon={Star}
                  title="Nothing tracked yet"
                  description="Add tickers from the Watchlist page to follow them here."
                  className="py-8"
                />
              ) : (
                (watchlistQ.data ?? []).map((item) => {
                  const q = getQuote(item.symbol);
                  const up = q.dayChangePct >= 0;
                  return (
                    <Link key={item.symbol} to="/app/stock/$symbol" params={{ symbol: item.symbol }} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{q.symbol.slice(0, 2)}</div>
                        <div className="min-w-0">
                          <div className="text-sm font-semibold">{q.symbol}</div>
                          <div className="truncate text-xs text-muted-foreground">{q.name}</div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <Sparkline data={sparkline(item.symbol)} up={up} width={64} height={24} />
                        <div className="text-right">
                          <div className="text-sm tabular">{fmtUSD(q.price)}</div>
                          <div className={cn("text-xs tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(q.dayChangePct)}</div>
                        </div>
                      </div>
                    </Link>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Top movers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {/* Market reference data — stays on the mock universe until Phase 5. */}
              {topMovers().map((s) => {
                const up = s.dayChangePct >= 0;
                return (
                  <Link key={s.symbol} to="/app/stock/$symbol" params={{ symbol: s.symbol }} className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-accent">
                    <div className="flex items-center gap-2">
                      <div className={cn("grid h-7 w-7 place-items-center rounded-md", up ? "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]" : "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]")}>
                        {up ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                      </div>
                      <div>
                        <div className="text-sm font-semibold">{s.symbol}</div>
                        <div className="text-xs text-muted-foreground">{fmtUSD(s.price)}</div>
                      </div>
                    </div>
                    <span className={cn("text-sm font-medium tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(s.dayChangePct)}</span>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "gain" | "loss" }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-2 text-2xl font-semibold tabular">{value}</p>
        {sub && (
          <p className={cn(
            "mt-1 text-xs tabular",
            tone === "gain" && "text-[color:var(--color-gain)]",
            tone === "loss" && "text-[color:var(--color-loss)]",
            !tone && "text-muted-foreground",
          )}>{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}
