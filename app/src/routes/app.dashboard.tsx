import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PriceChart, Sparkline } from "@/components/PriceChart";
import { HOLDINGS, WATCHLIST, CASH, getStock, portfolioValue, todaysChange, totalReturn, topMovers, fmtUSD, fmtPct, sparkline } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, Star } from "lucide-react";

export const Route = createFileRoute("/app/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard · PaperTrader" }],
  }),
  component: Dashboard,
});

function Dashboard() {
  const total = portfolioValue();
  const day = todaysChange();
  const ret = totalReturn();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Good to see you back</h1>
        <p className="text-sm text-muted-foreground">Here's where your paper portfolio stands today.</p>
      </div>

      {/* Stat row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Portfolio value" value={fmtUSD(total)} sub={`${HOLDINGS.length} holdings`} />
        <Stat label="Buying power" value={fmtUSD(CASH)} sub="Virtual cash available" />
        <Stat label="Today's change" value={`${day.abs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(day.abs))}`} sub={fmtPct(day.pct)} tone={day.abs >= 0 ? "gain" : "loss"} />
        <Stat label="Total return" value={`${ret.abs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(ret.abs))}`} sub={fmtPct(ret.pct)} tone={ret.abs >= 0 ? "gain" : "loss"} />
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
                  <p className={cn("mt-1 text-sm tabular", day.abs >= 0 ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                    {day.abs >= 0 ? "+" : "−"}{fmtUSD(Math.abs(day.abs))} ({fmtPct(day.pct)}) today
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <PriceChart symbol="AAPL" endPrice={total} height={300} defaultRange="3M" />
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
                  {HOLDINGS.map((h) => {
                    const s = getStock(h.symbol)!;
                    const mv = s.price * h.shares;
                    const pl = (s.price - h.avgCost) * h.shares;
                    const plPct = ((s.price - h.avgCost) / h.avgCost) * 100;
                    const up = pl >= 0;
                    return (
                      <tr key={h.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                        <td className="py-3">
                          <Link to="/app/stock/$symbol" params={{ symbol: s.symbol }} className="flex items-center gap-3">
                            <div className="grid h-8 w-8 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{s.symbol.slice(0, 2)}</div>
                            <div>
                              <div className="font-semibold">{s.symbol}</div>
                              <div className="text-xs text-muted-foreground">{s.name}</div>
                            </div>
                          </Link>
                        </td>
                        <td className="py-3 tabular">{h.shares}</td>
                        <td className="py-3 text-right tabular">{fmtUSD(h.avgCost)}</td>
                        <td className="py-3 text-right tabular">{fmtUSD(s.price)}</td>
                        <td className="py-3 text-right tabular">{fmtUSD(mv)}</td>
                        <td className={cn("py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                          {up ? "+" : "−"}{fmtUSD(Math.abs(pl))} <span className="text-xs opacity-80">({fmtPct(plPct)})</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
              {WATCHLIST.map((sym) => {
                const s = getStock(sym)!;
                const up = s.dayChangePct >= 0;
                return (
                  <Link key={sym} to="/app/stock/$symbol" params={{ symbol: sym }} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-accent">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{s.symbol.slice(0, 2)}</div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">{s.symbol}</div>
                        <div className="truncate text-xs text-muted-foreground">{s.name}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Sparkline data={sparkline(sym)} up={up} width={64} height={24} />
                      <div className="text-right">
                        <div className="text-sm tabular">{fmtUSD(s.price)}</div>
                        <div className={cn("text-xs tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(s.dayChangePct)}</div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Top movers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
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
