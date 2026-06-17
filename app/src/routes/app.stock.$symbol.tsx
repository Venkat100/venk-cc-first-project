import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LivePriceChart } from "@/components/LivePriceChart";
import { LoadingState } from "@/components/DataStates";
import { getQuote } from "@/lib/marketData";
import { getHoldings, getTransactions } from "@/lib/portfolio/queries";
import { executeTrade } from "@/lib/trading/execute";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD, fmtPct, fmtCompact } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/app/stock/$symbol")({
  loader: ({ params }) => ({ symbol: params.symbol.toUpperCase() }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.symbol ?? "Stock"} · PaperTrader` }],
  }),
  component: StockDetail,
});

function StockDetail() {
  const { symbol } = Route.useLoaderData();
  const quoteQ = useQuery({ queryKey: ["quote", symbol], queryFn: () => getQuote(symbol), staleTime: 15_000, refetchInterval: 30_000, retry: 1 });
  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: getHoldings });
  const txQ = useQuery({ queryKey: ["transactions"], queryFn: getTransactions });
  const { profile } = useAuth();

  const quote = quoteQ.data;
  const position = (holdingsQ.data ?? []).find((h) => h.symbol === symbol);
  const recent = useMemo(() => (txQ.data ?? []).filter((t) => t.symbol === symbol).slice(0, 8), [txQ.data, symbol]);

  // Invalid ticker or provider failure → friendly card, never a crash.
  if (quoteQ.isError) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <h2 className="text-lg font-semibold">Couldn't load {symbol}</h2>
        <p className="mt-1 text-sm text-muted-foreground">That ticker may be invalid, or the market data provider is temporarily unavailable.</p>
        <Link to="/app/markets"><Button className="mt-4">Back to markets</Button></Link>
      </div>
    );
  }

  const up = (quote?.dayChangePct ?? 0) >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface-2 text-sm font-bold">{symbol.slice(0, 2)}</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{symbol}</h1>
              {quote?.sector && quote.sector !== "—" && (
                <span className="rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{quote.sector}</span>
              )}
            </div>
            <p className="truncate text-sm text-muted-foreground">{quote?.name ?? "Loading…"}</p>
          </div>
        </div>
        <div className="text-right">
          {quote ? (
            <>
              <p className="text-3xl font-semibold tabular">{fmtUSD(quote.price)}</p>
              <p className={cn("text-sm tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                {up ? "+" : "−"}{fmtUSD(Math.abs(quote.dayChange))} ({fmtPct(quote.dayChangePct)}) today
              </p>
            </>
          ) : (
            <div className="h-10 w-32 animate-pulse rounded bg-surface-2" />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="p-5">
              <LivePriceChart symbol={symbol} height={340} defaultRange="3M" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Key stats</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {quote ? (
                <>
                  <Stat label="Open" value={quote.open != null ? fmtUSD(quote.open) : "—"} />
                  <Stat label="Day high" value={quote.high != null ? fmtUSD(quote.high) : "—"} />
                  <Stat label="Day low" value={quote.low != null ? fmtUSD(quote.low) : "—"} />
                  <Stat label="Prev close" value={quote.previousClose != null ? fmtUSD(quote.previousClose) : "—"} />
                  <Stat label="Volume" value={quote.volume != null ? fmtCompact(quote.volume) : "—"} />
                  <Stat label="52-wk range" value={quote.week52Low != null && quote.week52High != null ? `${fmtUSD(quote.week52Low)} – ${fmtUSD(quote.week52High)}` : "—"} />
                </>
              ) : (
                <div className="col-span-full"><LoadingState label="Loading stats…" /></div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <Tabs defaultValue="position">
                <TabsList>
                  <TabsTrigger value="position">Your position</TabsTrigger>
                  <TabsTrigger value="trades">Recent trades</TabsTrigger>
                  <TabsTrigger value="about">About</TabsTrigger>
                </TabsList>
                <TabsContent value="position" className="mt-4">
                  {position && quote ? (
                    <div className="grid gap-4 sm:grid-cols-4">
                      <Stat label="Shares" value={String(position.quantity)} />
                      <Stat label="Avg cost" value={fmtUSD(position.avg_cost)} />
                      <Stat label="Market value" value={fmtUSD(quote.price * position.quantity)} />
                      <Stat label="Unrealized P&L" value={`${(quote.price - position.avg_cost) * position.quantity >= 0 ? "+" : "−"}${fmtUSD(Math.abs((quote.price - position.avg_cost) * position.quantity))}`} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">You don't own any {symbol} yet. Place a paper order from the panel on the right.</p>
                  )}
                </TabsContent>
                <TabsContent value="trades" className="mt-4">
                  {recent.length ? (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b border-border text-left text-xs uppercase text-muted-foreground"><th className="py-2 font-medium">Date</th><th className="py-2 font-medium">Type</th><th className="py-2 font-medium text-right">Qty</th><th className="py-2 font-medium text-right">Price</th></tr></thead>
                      <tbody>
                        {recent.map((t) => (
                          <tr key={t.id} className="border-b border-border/60 last:border-0">
                            <td className="py-2 text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</td>
                            <td className="py-2 uppercase">{t.side}</td>
                            <td className="py-2 text-right tabular">{t.quantity}</td>
                            <td className="py-2 text-right tabular">{fmtUSD(t.price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-muted-foreground">No trades for {symbol} yet.</p>}
                </TabsContent>
                <TabsContent value="about" className="mt-4">
                  {/* TODO(Phase 5+): company profile/description needs a provider
                      profile endpoint; not wired this phase. */}
                  <p className="text-sm leading-relaxed text-muted-foreground">{quote?.name ?? symbol} ({symbol}). Live price and historical chart powered by real market data. A full company profile is coming in a later phase.</p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <OrderPanel price={quote?.price ?? 0} symbol={symbol} buyingPower={profile?.cash_balance ?? 0} ready={!!quote} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular">{value}</p>
    </div>
  );
}

function OrderPanel({ price, symbol, buyingPower, ready }: { price: number; symbol: string; buyingPower: number; ready: boolean }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState(1);
  const [limit, setLimit] = useState(price);
  const est = (type === "market" ? price : limit) * qty;

  const qc = useQueryClient();
  const { refreshProfile } = useAuth();

  const trade = useMutation({
    mutationFn: () => executeTrade({ symbol, side, quantity: qty }),
    onSuccess: async (r) => {
      // Refresh everything the trade affects so Dashboard/Portfolio/position update.
      await Promise.all([
        refreshProfile(),
        qc.invalidateQueries({ queryKey: ["holdings"] }),
        qc.invalidateQueries({ queryKey: ["transactions"] }),
      ]);
      toast.success(
        `${r.side === "buy" ? "Bought" : "Sold"} ${r.quantity} ${r.symbol} @ ${fmtUSD(r.price)}`,
        { description: `${r.side === "buy" ? "Cost" : "Proceeds"} ${fmtUSD(r.total)} · Buying power now ${fmtUSD(r.cashBalance)}` },
      );
    },
    onError: (e: Error) => toast.error(e.message || "That order couldn't be completed."),
  });

  function onConfirm() {
    if (type === "limit") {
      // TODO(Phase 6+): real limit-order handling (rest the order until the
      // market crosses the limit). For now only market orders execute.
      toast.info("Limit orders are coming soon — switch to a Market order to trade now.");
      return;
    }
    if (qty <= 0) {
      toast.error("Enter a quantity greater than zero.");
      return;
    }
    trade.mutate();
  }

  const pending = trade.isPending;

  return (
    <Card className="h-fit">
      <CardHeader className="pb-2"><CardTitle className="text-base">Place paper order</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-md bg-surface p-1">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)} className={cn("rounded px-3 py-1.5 text-sm font-medium capitalize", side === s ? (s === "buy" ? "bg-[color:var(--color-gain)] text-[color:var(--color-gain-foreground)]" : "bg-[color:var(--color-loss)] text-[color:var(--color-loss-foreground)]") : "text-muted-foreground")}>{s}</button>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label>Order type</Label>
          <Select value={type} onValueChange={(v: "market" | "limit") => setType(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="market">Market</SelectItem>
              <SelectItem value="limit">Limit (soon)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="qty">Quantity</Label>
          <Input id="qty" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))} className="tabular" />
        </div>

        {type === "limit" && (
          <div className="space-y-1.5">
            <Label htmlFor="limit">Limit price</Label>
            <Input id="limit" type="number" step="0.01" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="tabular" />
            <p className="text-[11px] text-muted-foreground">Limit orders aren't executed yet — use Market to trade now.</p>
          </div>
        )}

        <div className="rounded-md border border-border bg-surface p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Estimated {side === "buy" ? "cost" : "credit"}</span><span className="tabular font-medium">{fmtUSD(est)}</span></div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>Buying power</span><span className="tabular">{fmtUSD(buyingPower)}</span></div>
        </div>

        <Button
          disabled={!ready || pending}
          className={cn("w-full", side === "buy" ? "bg-[color:var(--color-gain)] text-[color:var(--color-gain-foreground)] hover:opacity-90" : "bg-[color:var(--color-loss)] text-[color:var(--color-loss-foreground)] hover:opacity-90")}
          onClick={onConfirm}
        >
          {pending ? "Placing…" : `Confirm ${side} · ${qty} ${symbol}`}
        </Button>
        <p className="text-[11px] text-muted-foreground">All orders are simulated paper trades. No real money is used.</p>
      </CardContent>
    </Card>
  );
}
