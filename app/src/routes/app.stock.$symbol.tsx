import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PriceChart } from "@/components/PriceChart";
import { getStock, HOLDINGS, TRANSACTIONS, CASH, fmtUSD, fmtPct, fmtCompact } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/app/stock/$symbol")({
  loader: ({ params }) => {
    const stock = getStock(params.symbol);
    if (!stock) throw notFound();
    return { stock };
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [{ title: `${loaderData.stock.symbol} · ${loaderData.stock.name} — PaperTrader` }, { name: "description", content: `${loaderData.stock.name} (${loaderData.stock.symbol}) — price, stats, and paper trading.` }]
      : [{ title: "Stock · PaperTrader" }],
  }),
  notFoundComponent: () => (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold">Ticker not found</h2>
      <p className="mt-1 text-sm text-muted-foreground">We don't have data for that symbol in the demo.</p>
      <Link to="/app/markets"><Button className="mt-4">Back to markets</Button></Link>
    </div>
  ),
  errorComponent: () => <div className="text-sm text-muted-foreground">Failed to load stock.</div>,
  component: StockDetail,
});

function StockDetail() {
  const { stock } = Route.useLoaderData();
  const up = stock.dayChangePct >= 0;
  const position = HOLDINGS.find((h) => h.symbol === stock.symbol);
  const recent = useMemo(() => TRANSACTIONS.filter((t) => t.symbol === stock.symbol).slice(0, 8), [stock.symbol]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface-2 text-sm font-bold">{stock.symbol.slice(0, 2)}</div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{stock.symbol}</h1>
              <span className="rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{stock.sector}</span>
            </div>
            <p className="truncate text-sm text-muted-foreground">{stock.name}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular">{fmtUSD(stock.price)}</p>
          <p className={cn("text-sm tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
            {up ? "+" : "−"}{fmtUSD(Math.abs(stock.dayChange))} ({fmtPct(stock.dayChangePct)}) today
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardContent className="p-5">
              <PriceChart symbol={stock.symbol} endPrice={stock.price} height={340} defaultRange="3M" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Key stats</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Open" value={fmtUSD(stock.open)} />
              <Stat label="Day high" value={fmtUSD(stock.high)} />
              <Stat label="Day low" value={fmtUSD(stock.low)} />
              <Stat label="Volume" value={fmtCompact(stock.volume)} />
              <Stat label="Market cap" value={`$${fmtCompact(stock.marketCap)}`} />
              <Stat label="52-wk range" value={`${fmtUSD(stock.week52Low)} – ${fmtUSD(stock.week52High)}`} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <Tabs defaultValue="about">
                <TabsList>
                  <TabsTrigger value="about">About</TabsTrigger>
                  <TabsTrigger value="position">Your position</TabsTrigger>
                  <TabsTrigger value="trades">Recent trades</TabsTrigger>
                </TabsList>
                <TabsContent value="about" className="mt-4">
                  <p className="text-sm leading-relaxed text-muted-foreground">{stock.about}</p>
                </TabsContent>
                <TabsContent value="position" className="mt-4">
                  {position ? (
                    <div className="grid gap-4 sm:grid-cols-4">
                      <Stat label="Shares" value={String(position.shares)} />
                      <Stat label="Avg cost" value={fmtUSD(position.avgCost)} />
                      <Stat label="Market value" value={fmtUSD(stock.price * position.shares)} />
                      <Stat label="Unrealized P&L" value={`${(stock.price - position.avgCost) * position.shares >= 0 ? "+" : "−"}${fmtUSD(Math.abs((stock.price - position.avgCost) * position.shares))}`} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">You don't own any {stock.symbol} yet. Place a paper order from the panel on the right.</p>
                  )}
                </TabsContent>
                <TabsContent value="trades" className="mt-4">
                  {recent.length ? (
                    <table className="w-full text-sm">
                      <thead><tr className="border-b border-border text-left text-xs uppercase text-muted-foreground"><th className="py-2 font-medium">Date</th><th className="py-2 font-medium">Type</th><th className="py-2 font-medium text-right">Qty</th><th className="py-2 font-medium text-right">Price</th></tr></thead>
                      <tbody>
                        {recent.map((t) => (
                          <tr key={t.id} className="border-b border-border/60 last:border-0">
                            <td className="py-2 text-muted-foreground">{new Date(t.date).toLocaleDateString()}</td>
                            <td className="py-2 uppercase">{t.type}</td>
                            <td className="py-2 text-right tabular">{t.qty}</td>
                            <td className="py-2 text-right tabular">{fmtUSD(t.price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-muted-foreground">No trades for {stock.symbol} yet.</p>}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <OrderPanel price={stock.price} symbol={stock.symbol} />
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

function OrderPanel({ price, symbol }: { price: number; symbol: string }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState(1);
  const [limit, setLimit] = useState(price);
  const est = (type === "market" ? price : limit) * qty;

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
              <SelectItem value="limit">Limit</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="qty">Quantity</Label>
          <Input id="qty" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} className="tabular" />
        </div>

        {type === "limit" && (
          <div className="space-y-1.5">
            <Label htmlFor="limit">Limit price</Label>
            <Input id="limit" type="number" step="0.01" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="tabular" />
          </div>
        )}

        <div className="rounded-md border border-border bg-surface p-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Estimated {side === "buy" ? "cost" : "credit"}</span><span className="tabular font-medium">{fmtUSD(est)}</span></div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>Buying power</span><span className="tabular">{fmtUSD(CASH)}</span></div>
        </div>

        <Button
          className={cn("w-full", side === "buy" ? "bg-[color:var(--color-gain)] text-[color:var(--color-gain-foreground)] hover:opacity-90" : "bg-[color:var(--color-loss)] text-[color:var(--color-loss-foreground)] hover:opacity-90")}
          onClick={() => toast.success(`${side === "buy" ? "Bought" : "Sold"} ${qty} ${symbol} @ ${fmtUSD(type === "market" ? price : limit)}`, { description: "Paper order filled (simulated)" })}
        >
          Confirm {side} · {qty} {symbol}
        </Button>
        <p className="text-[11px] text-muted-foreground">All orders are simulated. No real money is used.</p>
      </CardContent>
    </Card>
  );
}
