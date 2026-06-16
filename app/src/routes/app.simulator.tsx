import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STOCKS, fmtUSD, fmtPct, whatIf } from "@/lib/mockData";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Line, ComposedChart, CartesianGrid } from "recharts";
import { cn } from "@/lib/utils";
import { ArrowRight, FlaskConical, Sparkles } from "lucide-react";

export const Route = createFileRoute("/app/simulator")({
  head: () => ({ meta: [{ title: "What-If Simulator · PaperTrader" }] }),
  component: Simulator,
});

function Simulator() {
  const [symbol, setSymbol] = useState("NVDA");
  const [date, setDate] = useState("2020-06-15");
  const [amount, setAmount] = useState(10000);
  const [submitted, setSubmitted] = useState<{ symbol: string; date: string; amount: number } | null>({
    symbol: "NVDA", date: "2020-06-15", amount: 10000,
  });

  const result = useMemo(() => {
    if (!submitted) return null;
    return whatIf(submitted.symbol, new Date(submitted.date), submitted.amount);
  }, [submitted]);

  const stock = STOCKS.find((s) => s.symbol === submitted?.symbol);
  const up = (result?.totalReturnAbs ?? 0) >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <FlaskConical className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">What-If Simulator</h1>
          <p className="text-sm text-muted-foreground">If you had invested back then… see what would have happened.</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* Form */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Run a scenario</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Stock</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STOCKS.map((s) => (
                    <SelectItem key={s.symbol} value={s.symbol}>
                      <span className="font-semibold">{s.symbol}</span>
                      <span className="ml-2 text-muted-foreground">{s.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Investment date</Label>
              <Input id="date" type="date" max={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="amt">Amount (USD)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input id="amt" type="number" min={100} step={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="pl-7 tabular" />
              </div>
            </div>
            <Button onClick={() => setSubmitted({ symbol, date, amount })} className="w-full gap-2">
              Run simulation <ArrowRight className="h-4 w-4" />
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Simulations use historical-style mock data for now. Connect a market data API to use real history.
            </p>
          </CardContent>
        </Card>

        {/* Result */}
        <div className="space-y-6">
          {result && stock && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <ResultCard label="Worth today" value={fmtUSD(result.finalValue)} sub={`${result.shares.toFixed(2)} sh @ ${fmtUSD(result.startPrice)} start`} accent />
                <ResultCard label="Total return" value={`${up ? "+" : "−"}${fmtUSD(Math.abs(result.totalReturnAbs))}`} sub={fmtPct(result.totalReturnPct)} tone={up ? "gain" : "loss"} />
                <ResultCard label="vs. S&P 500" value={fmtUSD(result.sp500FinalValue)} sub={`${fmtPct(result.sp500ReturnPct)} index return`} />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-[color:var(--color-primary)]" />
                        ${submitted!.amount.toLocaleString()} invested in {stock.symbol} on {new Date(submitted!.date).toLocaleDateString()}
                      </CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">{stock.name} · {stock.sector}</p>
                    </div>
                    <div className={cn("rounded-md px-3 py-1.5 text-sm tabular font-medium", up ? "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]" : "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]")}>
                      {fmtPct(result.totalReturnPct)} vs {fmtPct(result.sp500ReturnPct)} S&P
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="h-[360px]">
                    <ResponsiveContainer>
                      <ComposedChart data={result.series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="wi-stock" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--color-gain)" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="var(--color-gain)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                        <XAxis dataKey="t" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", year: "2-digit" })} stroke="var(--color-muted-foreground)" fontSize={11} />
                        <YAxis tickFormatter={(v) => `$${Number(v).toLocaleString()}`} stroke="var(--color-muted-foreground)" fontSize={11} width={80} />
                        <Tooltip
                          contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                          labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                          formatter={(v: number, n) => [fmtUSD(v), n === "stock" ? stock.symbol : "S&P 500"]}
                        />
                        <Area type="monotone" dataKey="stock" stroke="var(--color-gain)" strokeWidth={2.5} fill="url(#wi-stock)" name="stock" />
                        <Line type="monotone" dataKey="sp500" stroke="var(--color-chart-2)" strokeWidth={2} strokeDasharray="4 4" dot={false} name="sp500" />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-2"><span className="h-2 w-3 rounded-sm bg-[color:var(--color-gain)]" /> {stock.symbol}</span>
                    <span className="flex items-center gap-2"><span className="h-2 w-3 rounded-sm bg-[color:var(--color-chart-2)]" /> S&P 500 (benchmark)</span>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultCard({ label, value, sub, tone, accent }: { label: string; value: string; sub?: string; tone?: "gain" | "loss"; accent?: boolean }) {
  return (
    <Card className={cn(accent && "border-[color:var(--color-primary)]/40 bg-gradient-to-br from-card to-primary/5")}>
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
