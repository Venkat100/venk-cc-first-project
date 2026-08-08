import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "@/components/PriceChart";
import { PortfolioValueChart } from "@/components/PortfolioValueChart";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { MarketBriefBody, AiDisclaimer } from "@/components/InsightUI";
import { getHoldings, getWatchlist } from "@/lib/portfolio/queries";
import { getOptionPositions } from "@/lib/options/queries";
import { getTodaysBrief } from "@/lib/insights/api";
import { getSnapshots } from "@/lib/snapshots/queries";
import { getMarginState } from "@/lib/margin/api";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { useAuth } from "@/lib/auth/auth-context";
import { topMovers, fmtUSD, fmtPct, fmtQty, sparkline, STARTING_CASH } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { ArrowUpRight, ArrowDownRight, Star, Wallet, Newspaper } from "lucide-react";

export const Route = createFileRoute("/app/dashboard")({
  head: () => ({
    meta: [{ title: "Dashboard · PaperTrader" }],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { profile } = useAuth();
  const cash = profile?.cash_balance ?? 0;
  // Margin-aware buying power: the extra live-priced getMarginState() call
  // only fires when the user has actually opted into margin (a free check
  // via profile, already fetched by useAuth()) — everyone else falls back
  // to cash, which is exactly what M1's own buying_power formula reduces to
  // when margin is off, so this is zero behavior change for most users.
  const marginStateQ = useQuery({
    queryKey: ["marginState"],
    queryFn: getMarginState,
    enabled: !!profile?.margin_enabled,
    staleTime: 10_000,
  });
  const buyingPower = profile?.margin_enabled && marginStateQ.data ? marginStateQ.data.buyingPower : cash;

  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: getHoldings });
  const watchlistQ = useQuery({ queryKey: ["watchlist"], queryFn: getWatchlist });
  // One shared query key — Portfolio and Stock Detail's Options tab read the
  // exact same live-priced list, so none of the three can disagree.
  const optionPositionsQ = useQuery({ queryKey: ["optionPositions"], queryFn: getOptionPositions });

  const holdings = holdingsQ.data ?? [];
  const watchItems = watchlistQ.data ?? [];
  const optionPositions = optionPositionsQ.data ?? [];

  // One live-quote fetch covers both the holdings table and the watchlist.
  // Real prices flow in through the server function (server-only API key).
  const symbols = useMemo(
    () => Array.from(new Set([...holdings.map((h) => h.symbol), ...watchItems.map((w) => w.symbol)])),
    [holdings, watchItems],
  );
  const quotesQ = useQuotes(symbols);
  const quotes = quotesQ.data;
  const pricesReady = (holdings.length === 0 || quotesQ.isSuccess) && optionPositionsQ.isSuccess;

  const snapshotsQ = useQuery({ queryKey: ["snapshots"], queryFn: getSnapshots });

  let holdingsValue = 0;
  let dayAbs = 0; // Σ(qty × today's change-vs-prior-close), from live quotes
  for (const h of holdings) {
    const q = quoteOf(quotes, h.symbol);
    holdingsValue += q.price * h.quantity;
    dayAbs += q.dayChange * h.quantity;
  }
  // Options (O3): each position is already live-repriced server-side
  // (lib/options/valuation.server.ts) — marketValue = current model premium
  // × 100 × contracts. dayChange there reprices the SAME contract at the
  // underlying's previous close (documented in that file) as the options
  // analogue of a stock's price-vs-prior-close delta.
  let optionsValue = 0;
  let optionsDayAbs = 0;
  for (const p of optionPositions) {
    optionsValue += p.marketValue;
    optionsDayAbs += p.dayChange;
  }
  // ── Portfolio math (single source of truth) ──────────────────────────
  // total_value      = cash + Σ(qty × live price) + Σ(option market value)
  // Today's change $ = Σ(qty × dayChange) + Σ(option dayChange)     (vs prior close; cash is flat intraday)
  // Today's change % = todayChange$ / (total_value − todayChange$)   (vs prior-close value)
  // Total return $   = total_value − $100,000 starting capital
  // Total return %   = (total_value − 100,000) / 100,000 × 100
  const total = cash + holdingsValue + optionsValue;
  const dayAbsTotal = dayAbs + optionsDayAbs;
  const priorCloseValue = total - dayAbsTotal;
  const dayPct = priorCloseValue > 0 ? (dayAbsTotal / priorCloseValue) * 100 : 0;
  const retAbs = total - STARTING_CASH;
  const retPct = (retAbs / STARTING_CASH) * 100;
  const dash = "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Good to see you back</h1>
        <p className="text-sm text-muted-foreground">Here's where your paper portfolio stands today.</p>
      </div>

      {/* Stat row — 2×2 on phones/tablets (Robinhood-style compact), 4-across on wide screens */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Stat label="Portfolio value" value={pricesReady ? fmtUSD(total) : dash} sub={`${holdings.length} holding${holdings.length === 1 ? "" : "s"}`} />
        <Stat label="Buying power" value={fmtUSD(buyingPower)} sub={profile?.margin_enabled ? "Cash + available margin" : "Virtual cash available"} />
        <Stat label="Today's change" value={pricesReady ? `${dayAbsTotal >= 0 ? "+" : "−"}${fmtUSD(Math.abs(dayAbsTotal))}` : dash} sub={pricesReady ? fmtPct(dayPct) : ""} tone={dayAbsTotal >= 0 ? "gain" : "loss"} />
        <Stat label="Total return" value={pricesReady ? `${retAbs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(retAbs))}` : dash} sub={pricesReady ? fmtPct(retPct) : ""} tone={retAbs >= 0 ? "gain" : "loss"} />
      </div>

      <MarketBriefCard hasTracked={symbols.length > 0} />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main chart + holdings */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-end justify-between">
                <div>
                  <CardTitle className="text-base font-medium text-muted-foreground">Portfolio value</CardTitle>
                  <p className="mt-1 text-3xl font-semibold tabular">{fmtUSD(total)}</p>
                  <p className={cn("mt-1 text-sm tabular", dayAbsTotal >= 0 ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                    {dayAbsTotal >= 0 ? "+" : "−"}{fmtUSD(Math.abs(dayAbsTotal))} ({fmtPct(dayPct)}) today
                  </p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <PortfolioValueChart
                snapshots={snapshotsQ.data ?? []}
                liveTotal={total}
                loading={snapshotsQ.isLoading}
                error={snapshotsQ.isError ? (snapshotsQ.error as Error)?.message : undefined}
                height={300}
              />
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
              ) : quotesQ.isError ? (
                <ErrorState message="Couldn't load live prices. Please try again in a moment." />
              ) : !pricesReady ? (
                <LoadingState label="Loading live prices…" />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 font-medium">Symbol</th>
                      <th className="hidden py-2 font-medium sm:table-cell">Shares</th>
                      <th className="hidden py-2 font-medium text-right sm:table-cell">Avg cost</th>
                      <th className="hidden py-2 font-medium text-right sm:table-cell">Price</th>
                      <th className="py-2 font-medium text-right">Market value</th>
                      <th className="py-2 font-medium text-right">Unrealized P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => {
                      const q = quoteOf(quotes, h.symbol);
                      const mv = q.price * h.quantity;
                      const pl = (q.price - h.avg_cost) * h.quantity;
                      const plPct = h.avg_cost > 0 ? ((q.price - h.avg_cost) / h.avg_cost) * 100 : 0;
                      const up = pl >= 0;
                      return (
                        <tr key={h.symbol} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
                          <td className="py-3">
                            <Link to="/app/stock/$symbol" params={{ symbol: q.symbol }} className="flex min-w-0 items-center gap-2 sm:gap-3">
                              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-bold">{q.symbol.slice(0, 2)}</div>
                              <div className="min-w-0">
                                <div className="font-semibold">{q.symbol}</div>
                                <div className="max-w-[100px] truncate text-xs text-muted-foreground sm:max-w-[180px]">{q.name}</div>
                              </div>
                            </Link>
                          </td>
                          <td className="hidden py-3 tabular sm:table-cell">{fmtQty(h.quantity)}</td>
                          <td className="hidden py-3 text-right tabular sm:table-cell">{fmtUSD(h.avg_cost)}</td>
                          <td className="hidden py-3 text-right tabular sm:table-cell">{fmtUSD(q.price)}</td>
                          <td className="py-3 text-right tabular">{fmtUSD(mv)}</td>
                          <td className={cn("py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                            {up ? "+" : "−"}{fmtUSD(Math.abs(pl))} <span className="hidden text-xs opacity-80 sm:inline">({fmtPct(plPct)})</span>
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
              ) : watchItems.length === 0 ? (
                <EmptyState
                  icon={Star}
                  title="Nothing tracked yet"
                  description="Add tickers from the Watchlist page to follow them here."
                  className="py-8"
                />
              ) : (
                watchItems.map((item) => {
                  const q = quoteOf(quotes, item.symbol);
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

function MarketBriefCard({ hasTracked }: { hasTracked: boolean }) {
  const briefQ = useQuery({ queryKey: ["todaysBrief"], queryFn: getTodaysBrief });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Newspaper className="h-4 w-4 text-[color:var(--color-primary)]" /> Today's market brief</CardTitle>
      </CardHeader>
      <CardContent>
        {briefQ.isLoading ? (
          <LoadingState label="Loading your brief…" />
        ) : briefQ.isError ? (
          <ErrorState message="Couldn't load your brief right now." />
        ) : briefQ.data ? (
          <MarketBriefBody brief={briefQ.data.brief} createdAt={briefQ.data.createdAt} />
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {hasTracked
                ? "Your AI market brief arrives after each market day — a quick read on the news moving your holdings and watchlist."
                : "Add holdings or watchlist tickers and your AI market brief — a quick read on the news moving them — will arrive after each market day."}
            </p>
            <AiDisclaimer />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "gain" | "loss" }) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-5">
        <p className="truncate text-[11px] uppercase tracking-wider text-muted-foreground sm:text-xs">{label}</p>
        <p className="mt-1.5 truncate text-lg font-semibold tabular sm:mt-2 sm:text-2xl">{value}</p>
        {sub && (
          <p className={cn(
            "mt-1 truncate text-xs tabular",
            tone === "gain" && "text-[color:var(--color-gain)]",
            tone === "loss" && "text-[color:var(--color-loss)]",
            !tone && "text-muted-foreground",
          )}>{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}
