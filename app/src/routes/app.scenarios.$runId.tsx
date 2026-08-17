// Scenario Challenges — the active-run / completed-review page.
//
// No ConfirmDialog on scenario trades (deliberate, unlike every real-money-
// adjacent trade elsewhere in the app): this is sandbox cash inside an
// already-isolated scenario, rapid back-and-forth trading through 30-50
// steps is the whole point, and a confirm-every-click flow would fight the
// format rather than teach anything.
//
// The chart/holdings/prices shown here are EXACTLY what
// getScenarioMarketDataFn decided to send — this page has no code path that
// could render a date beyond the server's own cutoff for an active run.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NumberInput, parseNumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { ScenarioChart } from "@/components/scenarios/ScenarioChart";
import { getScenarioMarketData, advanceScenarioStep, executeScenarioTrade } from "@/lib/scenarios/api";
import { getScenarioHoldings, getScenarioTransactions } from "@/lib/scenarios/queries";
import { getScenario } from "@/lib/scenarios/catalog";
import { fmtUSD, fmtPct, fmtQty } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ChevronsRight, TrendingUp, TrendingDown, History, Trophy, Info } from "lucide-react";

export const Route = createFileRoute("/app/scenarios/$runId")({
  head: () => ({ meta: [{ title: "Scenario Challenge · My PaperTrader" }] }),
  component: ScenarioRunPage,
});

function prettyDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function ScenarioRunPage() {
  const { runId } = Route.useParams();
  const qc = useQueryClient();

  const marketQ = useQuery({ queryKey: ["scenarioMarketData", runId], queryFn: () => getScenarioMarketData(runId) });
  const holdingsQ = useQuery({ queryKey: ["scenarioHoldings", runId], queryFn: () => getScenarioHoldings(runId) });
  const txQ = useQuery({ queryKey: ["scenarioTransactions", runId], queryFn: () => getScenarioTransactions(runId) });

  const [tradeSymbol, setTradeSymbol] = useState<string | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qtyInput, setQtyInput] = useState("1");

  async function refreshAll() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["scenarioMarketData", runId] }),
      qc.invalidateQueries({ queryKey: ["scenarioHoldings", runId] }),
      qc.invalidateQueries({ queryKey: ["scenarioTransactions", runId] }),
      qc.invalidateQueries({ queryKey: ["scenarioRuns"] }),
    ]);
  }

  const advanceMut = useMutation({
    mutationFn: () => advanceScenarioStep(runId),
    onSuccess: async ({ run }) => {
      await refreshAll();
      if (run.status === "completed") {
        toast.success("Scenario complete!", { description: `Final return: ${fmtPct(run.final_score ? run.final_score.userReturnPct * 100 : 0)}` });
      }
    },
    onError: (e: Error) => toast.error(e.message || "Couldn't advance."),
  });

  const tradeMut = useMutation({
    mutationFn: (input: { symbol: string; side: "buy" | "sell"; quantity: number }) => executeScenarioTrade(runId, input.symbol, input.side, input.quantity),
    onSuccess: async (result) => {
      await refreshAll();
      toast.success(`${result.side === "buy" ? "Bought" : "Sold"} ${fmtQty(result.quantity)} ${result.symbol} @ ${fmtUSD(result.price)}`);
      setQtyInput("1");
    },
    onError: (e: Error) => toast.error(e.message || "Trade failed."),
  });

  if (marketQ.isLoading) return <div className="py-16"><LoadingState label="Loading your scenario…" /></div>;
  if (marketQ.isError || !marketQ.data) return <div className="py-16"><ErrorState message={(marketQ.error as Error)?.message} /></div>;

  const data = marketQ.data;
  const scenario = getScenario(data.scenarioId);
  if (!scenario) return <div className="py-16"><ErrorState message="That scenario is no longer available." /></div>;

  const run = data.run;
  const isActive = run.status === "active";
  const holdings = holdingsQ.data ?? [];
  const holdingsValue = holdings.reduce((sum, h) => sum + h.quantity * (data.latestPrices[h.symbol] ?? 0), 0);
  const portfolioValue = run.cash + holdingsValue;
  const portfolioReturnPct = (portfolioValue - run.starting_cash) / run.starting_cash;

  const tradeableSymbols = [...scenario.symbols.map((s) => s.symbol), scenario.benchmarkSymbol];
  const activeSymbol = tradeSymbol ?? tradeableSymbols[0];
  const activePrice = data.latestPrices[activeSymbol];
  const heldQty = holdings.find((h) => h.symbol === activeSymbol)?.quantity ?? 0;
  const parsedQty = parseNumberInput(qtyInput);
  const qty = parsedQty ?? 0;
  const estCost = activePrice != null ? qty * activePrice : 0;
  const qtyReason = parsedQty == null ? "Enter a quantity." : qty <= 0 ? "Enter a quantity greater than zero." : null;
  const canSubmit = qtyReason == null && activePrice != null && (side === "buy" ? estCost <= run.cash + 1e-6 : qty <= heldQty + 1e-9);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{scenario.title}</h1>
          <p className="text-sm text-muted-foreground">{scenario.tagline}</p>
        </div>
        <Badge variant={isActive ? "default" : "secondary"} className="shrink-0">{isActive ? "In progress" : "Completed"}</Badge>
      </div>

      {isActive && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 p-4">
            <div className="min-w-[160px] flex-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Simulated date: <span className="text-foreground font-medium">{prettyDate(data.cutoffDate)}</span></span>
                <span>step {run.step_index + 1} of {data.maxStepIndex + 1}</span>
              </div>
              <Progress value={((run.step_index + 1) / (data.maxStepIndex + 1)) * 100} className="mt-1.5 h-1.5" />
            </div>
            <Button className="gap-2 shrink-0" disabled={advanceMut.isPending} onClick={() => advanceMut.mutate()}>
              <ChevronsRight className="h-4 w-4" /> {advanceMut.isPending ? "Advancing…" : `Advance ${scenario.stepTradingDays} trading days`}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Cash" value={fmtUSD(run.cash)} />
        <StatCard label="Holdings value" value={fmtUSD(holdingsValue)} />
        <StatCard label="Total return" value={fmtPct(portfolioReturnPct * 100)} tone={portfolioReturnPct >= 0 ? "gain" : "loss"} />
      </div>

      {!isActive && run.final_score && <ScenarioResults score={run.final_score} scenarioTitle={scenario.title} debrief={scenario.debrief} />}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Price history {isActive ? "(up to today)" : ""}</CardTitle></CardHeader>
        <CardContent>
          <ScenarioChart series={data.series} symbols={scenario.symbols.map((s) => s.symbol)} benchmarkSymbol={scenario.benchmarkSymbol} />
        </CardContent>
      </Card>

      {isActive && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Trade</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label>Symbol</Label>
                <Select value={activeSymbol} onValueChange={setTradeSymbol}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {tradeableSymbols.map((s) => (
                      <SelectItem key={s} value={s}>{s}{s === scenario.benchmarkSymbol ? " (benchmark)" : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {scenario.symbols.find((s) => s.symbol === activeSymbol) && (
                  <p className="text-xs text-muted-foreground">{scenario.symbols.find((s) => s.symbol === activeSymbol)!.blurb}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Current price</Label>
                <p className="tabular text-lg font-semibold">{activePrice != null ? fmtUSD(activePrice) : "—"}</p>
              </div>
            </div>

            <RadioGroup value={side} onValueChange={(v) => setSide(v as "buy" | "sell")} className="flex gap-4">
              <Label className="flex cursor-pointer items-center gap-1.5 text-sm font-normal"><RadioGroupItem value="buy" /> Buy</Label>
              <Label className="flex cursor-pointer items-center gap-1.5 text-sm font-normal"><RadioGroupItem value="sell" /> Sell</Label>
            </RadioGroup>

            <div className="space-y-1.5">
              <Label htmlFor="scenario-qty">Quantity (shares)</Label>
              <NumberInput id="scenario-qty" decimals={6} value={qtyInput} onValueChange={setQtyInput} />
              <p className="text-xs text-muted-foreground">
                {qtyReason ?? (side === "buy" ? `Est. cost ${fmtUSD(estCost)} · cash available ${fmtUSD(run.cash)}` : `You hold ${fmtQty(heldQty)} ${activeSymbol}`)}
              </p>
            </div>

            <Button className="w-full" disabled={!canSubmit || tradeMut.isPending} onClick={() => tradeMut.mutate({ symbol: activeSymbol, side, quantity: qty })}>
              {tradeMut.isPending ? "Placing order…" : `${side === "buy" ? "Buy" : "Sell"} ${activeSymbol}`}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Holdings</CardTitle></CardHeader>
        <CardContent className="p-0">
          {holdings.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No positions yet" description="Place a trade above to open a position in this scenario." />
          ) : (
            <div className="divide-y divide-border/60">
              {holdings.map((h) => {
                const price = data.latestPrices[h.symbol] ?? 0;
                const value = h.quantity * price;
                const pnl = value - h.quantity * h.avg_cost;
                const pnlPct = h.avg_cost > 0 ? (price - h.avg_cost) / h.avg_cost : 0;
                return (
                  <div key={h.symbol} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="font-semibold">{h.symbol}</p>
                      <p className="text-xs text-muted-foreground">{fmtQty(h.quantity)} @ {fmtUSD(h.avg_cost)} avg</p>
                    </div>
                    <div className="text-right">
                      <p className="tabular font-medium">{fmtUSD(value)}</p>
                      <p className={cn("text-xs tabular", pnl >= 0 ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                        {pnl >= 0 ? "+" : "−"}{fmtUSD(Math.abs(pnl))} ({fmtPct(pnlPct * 100)})
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" /> Trade history</CardTitle></CardHeader>
        <CardContent className="p-0">
          {txQ.isLoading ? (
            <LoadingState label="Loading…" />
          ) : (txQ.data ?? []).length === 0 ? (
            <EmptyState icon={History} title="No trades yet" description="Every buy and sell in this scenario will show up here." />
          ) : (
            <div className="max-h-[360px] divide-y divide-border/60 overflow-y-auto">
              {(txQ.data ?? []).map((t) => (
                <div key={t.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    {t.side === "buy" ? <TrendingUp className="h-3.5 w-3.5 text-[color:var(--color-gain)]" /> : <TrendingDown className="h-3.5 w-3.5 text-[color:var(--color-loss)]" />}
                    <span className="font-medium">{t.side === "buy" ? "Bought" : "Sold"} {fmtQty(t.quantity)} {t.symbol}</span>
                  </div>
                  <div className="text-right">
                    <p className="tabular">{fmtUSD(t.total)}</p>
                    <p className="text-[11px] text-muted-foreground">{prettyDate(t.sim_date)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={cn("mt-1 text-xl font-semibold tabular", tone === "gain" && "text-[color:var(--color-gain)]", tone === "loss" && "text-[color:var(--color-loss)]")}>{value}</p>
      </CardContent>
    </Card>
  );
}

function ScenarioResults({ score, scenarioTitle, debrief }: { score: import("@/lib/scenarios/scoring").ScenarioScore; scenarioTitle: string; debrief: string }) {
  const beat = score.beatBenchmark;
  return (
    <>
      <Card className="border-[color:var(--color-primary)]/40 bg-gradient-to-br from-card to-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Trophy className="h-4 w-4 text-[color:var(--color-primary)]" /> Results — {scenarioTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Your return</p>
              <p className={cn("mt-1 text-2xl font-bold tabular", score.userReturnPct >= 0 ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(score.userReturnPct * 100)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Buy &amp; hold benchmark</p>
              <p className="mt-1 text-2xl font-bold tabular text-foreground">{fmtPct(score.benchmarkReturnPct * 100)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Best single stock</p>
              <p className="mt-1 text-lg font-semibold tabular text-[color:var(--color-gain)]">{score.bestSingleStock.symbol} {fmtPct(score.bestSingleStock.returnPct * 100)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Worst single stock</p>
              <p className="mt-1 text-lg font-semibold tabular text-[color:var(--color-loss)]">{score.worstSingleStock.symbol} {fmtPct(score.worstSingleStock.returnPct * 100)}</p>
            </div>
          </div>
          <p className={cn("text-sm font-medium", beat ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
            You {beat ? "beat" : "lagged"} a simple buy-and-hold of the benchmark by {fmtPct(Math.abs(score.userReturnPct - score.benchmarkReturnPct) * 100)}.
          </p>
          <p className="text-xs text-muted-foreground">Final: {fmtUSD(score.finalPortfolioValue)} ({fmtUSD(score.finalCash)} cash + {fmtUSD(score.finalHoldingsValue)} in positions) from a {fmtUSD(score.startingCash)} start.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Every stock's outcome</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {[...score.perSymbolReturns].sort((a, b) => b.returnPct - a.returnPct).map((s) => (
            <div key={s.symbol} className="flex items-center justify-between text-sm">
              <span className="font-medium">{s.symbol}</span>
              <span className={cn("tabular", s.returnPct >= 0 ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>{fmtPct(s.returnPct * 100)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Info className="h-4 w-4" /> What actually happened</CardTitle></CardHeader>
        <CardContent><p className="text-sm leading-relaxed text-foreground/90">{debrief}</p></CardContent>
      </Card>
    </>
  );
}
