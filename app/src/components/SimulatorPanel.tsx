import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runSimulation, type SimResult } from "@/lib/simulator/run";
import { MARKET_UNIVERSE } from "@/lib/marketData";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD, fmtPct } from "@/lib/mockData";
import { Area, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { cn } from "@/lib/utils";
import { ArrowRight, FlaskConical, Sparkles, TrendingUp, TrendingDown, Loader2, AlertCircle, ShoppingCart } from "lucide-react";

const EXAMPLES = [
  { symbol: "NVDA", date: "2019-06-03", amount: 5000, label: "$5k in NVDA · 2019" },
  { symbol: "AAPL", date: "2022-01-03", amount: 1000, label: "$1k in AAPL · 2022" },
  { symbol: "TSLA", date: "2020-01-02", amount: 2000, label: "$2k in TSLA · 2020" },
];

const SUGGESTIONS = Array.from(new Set([...MARKET_UNIVERSE, "SPY", "QQQ", "GOOG", "NFLX", "JPM", "DIS", "KO"]));

function prettyDate(iso: string) {
  // `iso` is a date-only string (YYYY-MM-DD) = UTC midnight. Format in UTC so
  // the displayed day matches the date the user picked — otherwise timezones
  // behind UTC render it a day early.
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function SimulatorPanel() {
  const [symbol, setSymbol] = useState("NVDA");
  const [date, setDate] = useState("2019-06-03");
  const [amount, setAmount] = useState(5000);

  const sim = useMutation({ mutationFn: runSimulation });
  const result = sim.data;

  function run(s = symbol, d = date, a = amount) {
    setSymbol(s); setDate(d); setAmount(a);
    sim.mutate({ symbol: s, date: d, amount: a });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <FlaskConical className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">What-If Simulator</h1>
          <p className="text-sm text-muted-foreground">If you'd invested back then… see what it would be worth today — vs. the S&P 500.</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* Form */}
        <Card className="h-fit">
          <CardHeader className="pb-2"><CardTitle className="text-base">Run a scenario</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="sym">Stock ticker</Label>
              <Input
                id="sym"
                list="sim-symbols"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="e.g. NVDA"
                className="font-semibold uppercase"
              />
              <datalist id="sim-symbols">
                {SUGGESTIONS.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Investment date</Label>
              <Input id="date" type="date" max={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="amt">Amount (USD)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input id="amt" type="number" min={1} step={100} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 0))} className="pl-7 tabular" />
              </div>
            </div>
            <Button onClick={() => run()} disabled={sim.isPending || !symbol.trim()} className="w-full gap-2">
              {sim.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Running…</> : <>Run simulation <ArrowRight className="h-4 w-4" /></>}
            </Button>
            <div className="space-y-1.5 pt-1">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Try an example</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button key={ex.label} onClick={() => run(ex.symbol, ex.date, ex.amount)} disabled={sim.isPending}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-[color:var(--color-primary)]/50 hover:text-foreground disabled:opacity-50">
                    {ex.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Uses real historical market data. No account needed.</p>
          </CardContent>
        </Card>

        {/* Result */}
        <div className="space-y-6">
          {sim.isPending && (
            <Card><CardContent className="flex h-[480px] flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-sm">Crunching real market history…</p>
            </CardContent></Card>
          )}

          {sim.isError && !sim.isPending && (
            <Card><CardContent className="flex h-[300px] flex-col items-center justify-center gap-2 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-full bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]"><AlertCircle className="h-5 w-5" /></div>
              <p className="text-sm font-medium">Couldn't run that one</p>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">{(sim.error as Error)?.message}</p>
            </CardContent></Card>
          )}

          {result && !sim.isPending && !sim.isError && <SimResultView result={result} />}

          {!result && !sim.isPending && !sim.isError && (
            <Card><CardContent className="flex h-[480px] flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <FlaskConical className="h-8 w-8 opacity-60" />
              <p className="text-sm">Pick a stock, a past date, and an amount — then hit <span className="text-foreground font-medium">Run</span>.</p>
              <p className="text-xs">Or tap an example to see the magic.</p>
            </CardContent></Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SimResultView({ result }: { result: SimResult }) {
  const { session } = useAuth();
  const up = result.returnAbs >= 0;
  const beat = result.beatMarketPct >= 0;

  return (
    <>
      {result.earliestAvailable && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
          Heads up: price history for {result.symbol} only goes back to <span className="text-foreground">{prettyDate(result.earliestAvailable)}</span> — we used that as the start date.
        </div>
      )}

      {/* Headline */}
      <Card className="border-[color:var(--color-primary)]/40 bg-gradient-to-br from-card to-primary/5">
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">
            {fmtUSD(result.amount)} in <span className="font-semibold text-foreground">{result.symbol}</span> on {prettyDate(result.startDate)} would be worth
          </p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="text-4xl font-bold tabular">{fmtUSD(result.valueToday)}</span>
            <span className={cn("text-lg font-semibold tabular", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
              {up ? "+" : "−"}{fmtUSD(Math.abs(result.returnAbs))} ({fmtPct(result.returnPct)})
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {result.shares.toFixed(2)} shares @ {fmtUSD(result.startPrice)} → {fmtUSD(result.latestPrice)} today
          </p>
        </CardContent>
      </Card>

      {/* vs SPY + CTA */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              {beat ? <TrendingUp className="h-4 w-4 text-[color:var(--color-gain)]" /> : <TrendingDown className="h-4 w-4 text-[color:var(--color-loss)]" />}
              <span className={beat ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]"}>
                {beat ? "Beat" : "Lagged"} the S&P 500 by {Math.abs(result.beatMarketPct).toFixed(1)}%
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Same {fmtUSD(result.amount)} in the S&P 500 (SPY) → <span className="tabular text-foreground">{fmtUSD(result.spyValueToday)}</span> ({fmtPct(result.spyReturnPct)})
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-card to-primary/5">
          <CardContent className="flex h-full flex-col justify-center gap-2 p-5">
            {session ? (
              <>
                <p className="text-sm font-medium">Like what you see?</p>
                <Link to="/app/stock/$symbol" params={{ symbol: result.symbol }}>
                  <Button className="w-full gap-2"><ShoppingCart className="h-4 w-4" /> Buy {result.symbol} now</Button>
                </Link>
                <p className="text-[11px] text-muted-foreground">Trade it at today's live price with your virtual $100k.</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Want to start for real (with fake money)?</p>
                <Link to="/auth">
                  <Button className="w-full gap-2"><Sparkles className="h-4 w-4" /> Sign up to trade with $100k</Button>
                </Link>
                <p className="text-[11px] text-muted-foreground">Free paper-trading account. No real money, ever.</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[color:var(--color-primary)]" /> Growth of {fmtUSD(result.amount)} — {result.symbol} vs S&P 500
            </CardTitle>
            <div className={cn("rounded-md px-3 py-1.5 text-sm tabular font-medium", beat ? "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]" : "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]")}>
              {fmtPct(result.returnPct)} vs {fmtPct(result.spyReturnPct)} S&P
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-[360px]">
            <ResponsiveContainer>
              <ComposedChart data={result.series} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="sim-invest" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-gain)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-gain)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="t" tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", year: "2-digit" })} stroke="var(--color-muted-foreground)" fontSize={11} minTickGap={32} />
                <YAxis tickFormatter={(v) => `$${Number(v).toLocaleString()}`} stroke="var(--color-muted-foreground)" fontSize={11} width={80} />
                <Tooltip
                  contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(v) => new Date(v as string).toLocaleDateString()}
                  formatter={(v: number, n) => [fmtUSD(v), n === "invest" ? result.symbol : "S&P 500"]}
                />
                <Area type="monotone" dataKey="invest" stroke="var(--color-gain)" strokeWidth={2.5} fill="url(#sim-invest)" name="invest" />
                <Line type="monotone" dataKey="spy" stroke="var(--color-chart-2)" strokeWidth={2} strokeDasharray="4 4" dot={false} name="spy" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-2"><span className="h-2 w-3 rounded-sm bg-[color:var(--color-gain)]" /> {result.symbol}</span>
            <span className="flex items-center gap-2"><span className="h-2 w-3 rounded-sm bg-[color:var(--color-chart-2)]" /> S&P 500 (benchmark)</span>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
