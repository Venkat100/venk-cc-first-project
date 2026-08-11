import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { FlashPrice } from "@/components/FlashPrice";
import { MarketStatusBadge } from "@/components/MarketStatusBadge";
import { getHoldings, getTransactions } from "@/lib/portfolio/queries";
import { getOptionPositions, getOptionTransactions, type OptionTransaction } from "@/lib/options/queries";
import { getNotedTransactionIds } from "@/lib/journal/queries";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { fmtUSD, fmtPct, fmtQty } from "@/lib/mockData";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { cn } from "@/lib/utils";
import { OptionPositionsList } from "@/components/options/OptionPositionsList";
import { OptionOrderPanel, type OrderPanelState } from "@/components/options/OptionOrderPanel";
import { Wallet, Receipt, PieChart as PieIcon, LineChart, NotebookPen } from "lucide-react";

export const Route = createFileRoute("/app/portfolio")({
  head: () => ({ meta: [{ title: "Portfolio · PaperTrader" }] }),
  component: Portfolio,
});

const COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)", "var(--color-primary)"];

function Portfolio() {
  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: getHoldings });
  const txQ = useQuery({ queryKey: ["transactions"], queryFn: getTransactions });
  const notedTxQ = useQuery({ queryKey: ["notedTransactionIds"], queryFn: getNotedTransactionIds });
  const notedTransactionIds = notedTxQ.data ?? new Set<string>();
  const optionPositionsQ = useQuery({ queryKey: ["optionPositions"], queryFn: getOptionPositions });
  const optionTxQ = useQuery({ queryKey: ["optionTransactions"], queryFn: getOptionTransactions });

  const holdings = holdingsQ.data ?? [];
  const transactions = txQ.data ?? [];
  const optionPositions = optionPositionsQ.data ?? [];
  const recentOptionActivity = (optionTxQ.data ?? []).slice(0, 5);
  const optionsValue = useMemo(() => optionPositions.reduce((sum, p) => sum + p.marketValue, 0), [optionPositions]);
  const [orderPanel, setOrderPanel] = useState<OrderPanelState>({ open: false });

  const symbols = useMemo(() => holdings.map((h) => h.symbol), [holdings]);
  const quotesQ = useQuotes(symbols);
  const quotes = quotesQ.data;
  const pricesReady = holdings.length === 0 || quotesQ.isSuccess;

  const byStock = useMemo(
    () => holdings.map((h) => ({ name: h.symbol, value: +(quoteOf(quotes, h.symbol).price * h.quantity).toFixed(2) })),
    [holdings, quotes],
  );

  const bySector = useMemo(() => {
    const map = new Map<string, number>();
    for (const h of holdings) {
      const q = quoteOf(quotes, h.symbol);
      map.set(q.sector, (map.get(q.sector) ?? 0) + q.price * h.quantity);
    }
    return Array.from(map, ([name, value]) => ({ name, value: +value.toFixed(2) }));
  }, [holdings, quotes]);

  const [page, setPage] = useState(1);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(transactions.length / pageSize));
  const txPage = transactions.slice((page - 1) * pageSize, page * pageSize);

  const allocationsReady = !holdingsQ.isLoading && !holdingsQ.isError && holdings.length > 0 && pricesReady;
  const allocState = {
    isLoading: holdingsQ.isLoading || (holdings.length > 0 && quotesQ.isLoading),
    isError: holdingsQ.isError || quotesQ.isError,
    error: holdingsQ.error ?? quotesQ.error,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Portfolio & Activity</h1>
        <p className="text-sm text-muted-foreground">Allocation breakdown and full transaction history.</p>
        <MarketStatusBadge className="mt-1" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DonutCard title="Allocation by stock" data={byStock} state={allocState} ready={allocationsReady} />
        <DonutCard title="Allocation by sector" data={bySector} state={allocState} ready={allocationsReady} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Holdings detail</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {holdingsQ.isLoading ? (
            <LoadingState label="Loading your holdings…" />
          ) : holdingsQ.isError ? (
            <ErrorState message={(holdingsQ.error as Error)?.message} />
          ) : holdings.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No holdings yet"
              description="Start trading to build your portfolio — your positions and allocation will show up here."
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
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="hidden py-3 font-medium sm:table-cell">Sector</th>
                  <th className="hidden py-3 font-medium text-right sm:table-cell">Shares</th>
                  <th className="hidden py-3 font-medium text-right md:table-cell">Avg cost</th>
                  <th className="hidden py-3 font-medium text-right sm:table-cell">Price</th>
                  <th className="py-3 font-medium text-right">Market value</th>
                  <th className="px-4 py-3 font-medium text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const q = quoteOf(quotes, h.symbol);
                  const mv = q.price * h.quantity;
                  const pl = (q.price - h.avg_cost) * h.quantity;
                  const up = pl >= 0;
                  return (
                    <tr key={h.symbol} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 font-semibold">{q.symbol}</td>
                      <td className="hidden py-3 text-xs text-muted-foreground sm:table-cell">{q.sector}</td>
                      <td className="hidden py-3 text-right tabular sm:table-cell">{fmtQty(h.quantity)}</td>
                      <td className="hidden py-3 text-right tabular md:table-cell">{fmtUSD(h.avg_cost)}</td>
                      <td className="hidden py-3 text-right tabular sm:table-cell"><FlashPrice value={q.price} className="px-1">{fmtUSD(q.price)}</FlashPrice></td>
                      <td className="py-3 text-right tabular">{fmtUSD(mv)}</td>
                      <td className={cn("px-4 py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                        {up ? "+" : "−"}{fmtUSD(Math.abs(pl))} <span className="hidden text-xs opacity-80 sm:inline">({fmtPct(h.avg_cost > 0 ? ((q.price - h.avg_cost) / h.avg_cost) * 100 : 0)})</span>
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
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><LineChart className="h-4 w-4" /> Options</CardTitle>
            {optionPositions.length > 0 && <span className="text-xs tabular text-muted-foreground">Total value {fmtUSD(optionsValue)}</span>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {optionPositionsQ.isLoading ? (
            <LoadingState label="Pricing your option positions…" />
          ) : optionPositionsQ.isError ? (
            <ErrorState message={(optionPositionsQ.error as Error)?.message} />
          ) : (
            <OptionPositionsList positions={optionPositions} onSell={(p) => setOrderPanel({ open: true, mode: "sell", position: p })} showSymbolLink emptyDescription="Buy a call or put from any stock's Options tab — your positions across every symbol show up here." />
          )}
          {recentOptionActivity.length > 0 && (
            <div className="border-t border-border px-4 py-3">
              <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Recent option activity</p>
              <ul className="space-y-1.5">
                {recentOptionActivity.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground">{optionActivityLabel(t)}</span>
                    <span className="shrink-0 tabular text-xs text-muted-foreground">{new Date(t.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Transaction history</CardTitle>
            {transactions.length > 0 && <span className="text-xs text-muted-foreground">{transactions.length} transaction{transactions.length === 1 ? "" : "s"}</span>}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {txQ.isLoading ? (
            <LoadingState label="Loading your activity…" />
          ) : txQ.isError ? (
            <ErrorState message={(txQ.error as Error)?.message} />
          ) : transactions.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No activity yet"
              description="Your buys and sells will appear here as a full, time-stamped ledger once you start trading."
            />
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="py-3 font-medium">Type</th>
                    <th className="py-3 font-medium">Symbol</th>
                    <th className="hidden py-3 font-medium text-right sm:table-cell">Qty</th>
                    <th className="hidden py-3 font-medium text-right sm:table-cell">Price</th>
                    <th className="px-4 py-3 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {txPage.map((t) => (
                    <tr key={t.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3 tabular text-muted-foreground">{new Date(t.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
                      <td className="py-3">
                        <span className={cn(
                          "rounded-md px-2 py-0.5 text-xs font-medium uppercase tracking-wider",
                          t.side === "buy"
                            ? "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]"
                            : "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]",
                        )}>{t.side}</span>
                      </td>
                      <td className="py-3 font-semibold">
                        <span className="inline-flex items-center gap-1.5">
                          {t.symbol}
                          {notedTransactionIds.has(t.id) && (
                            <Link to="/app/journal" search={{ symbol: t.symbol }} title="View journal note" className="text-muted-foreground hover:text-foreground">
                              <NotebookPen className="h-3.5 w-3.5" />
                            </Link>
                          )}
                        </span>
                      </td>
                      <td className="hidden py-3 text-right tabular sm:table-cell">{fmtQty(t.quantity)}</td>
                      <td className="hidden py-3 text-right tabular sm:table-cell">{fmtUSD(t.price)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtUSD(t.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
                <span>Page {page} of {totalPages}</span>
                <div className="flex gap-2">
                  <button disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">Prev</button>
                  <button disabled={page === totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="rounded-md border border-border px-3 py-1 disabled:opacity-50">Next</button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <OptionOrderPanel state={orderPanel} onClose={() => setOrderPanel({ open: false })} />
    </div>
  );
}

// O4: labels an option_transactions row for the "Recent option activity"
// list — 'expired'/'settled' come from the daily expiration cron
// (lib/options/expiry.server.ts), buy/sell from a manual trade.
function optionActivityLabel(t: OptionTransaction): string {
  const parts = t.contract_id.split("-");
  const strike = parts[parts.length - 1];
  const type = parts[parts.length - 2] === "C" ? "Call" : "Put";
  const label = `${t.symbol} $${strike} ${type}`;
  switch (t.side) {
    case "buy_to_open":
      return `Bought ${t.contracts} ${label}`;
    case "sell_to_close":
      return `Sold ${t.contracts} ${label}`;
    case "settled":
      return `${label} settled — ${fmtUSD(t.total)} credited`;
    case "expired":
      return `${label} expired worthless`;
    default:
      return label;
  }
}

function DonutCard({
  title,
  data,
  state,
  ready,
}: {
  title: string;
  data: { name: string; value: number }[];
  state: { isLoading: boolean; isError: boolean; error: unknown };
  ready: boolean;
}) {
  const total = data.reduce((a, b) => a + b.value, 0);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="h-[260px]">
          {state.isLoading ? (
            <LoadingState label="Loading…" />
          ) : state.isError ? (
            <ErrorState message={(state.error as Error)?.message} />
          ) : !ready ? (
            <EmptyState
              icon={PieIcon}
              title="Nothing to allocate yet"
              description="Your allocation breakdown appears once you hold positions."
            />
          ) : (
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2} stroke="var(--color-background)">
                  {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number, n) => [`${fmtUSD(v)} (${total > 0 ? ((v / total) * 100).toFixed(1) : "0"}%)`, n as string]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
