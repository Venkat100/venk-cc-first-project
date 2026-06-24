import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { PortfolioValueChart } from "@/components/PortfolioValueChart";
import { getAgentConfig, updateAgentConfig, fundAgent, runAgentThinker, runAgentWatchdog } from "@/lib/agent/api";
import { getAgentHoldings, getAgentDecisions, getAgentSnapshots } from "@/lib/agent/queries";
import { useQuotes, quoteOf } from "@/lib/marketData/useQuotes";
import { getCandles } from "@/lib/marketData";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD, fmtPct } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import type { RiskLevel, AgentMode, AgentDecision } from "@/lib/supabase/types";
import { toast } from "sonner";
import { Bot, ShieldAlert, Wallet, LineChart, ListTree, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, ShoppingCart, RefreshCw, Eye, Scissors, PauseCircle } from "lucide-react";

export const Route = createFileRoute("/app/agent")({
  head: () => ({ meta: [{ title: "AI Agent · PaperTrader" }] }),
  component: Agent,
});

const RISKS: { id: RiskLevel; label: string; desc: string }[] = [
  { id: "conservative", label: "Conservative", desc: "Capital preservation — fewer, steadier positions." },
  { id: "balanced", label: "Balanced", desc: "A diversified mix of growth and stability." },
  { id: "aggressive", label: "Aggressive", desc: "Higher risk for higher potential return." },
];

const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: "autonomous", label: "Autonomous", desc: "The agent trades on its own within guardrails." },
  { id: "approve", label: "Approve first", desc: "The agent proposes; you approve each trade." },
];

function Agent() {
  const qc = useQueryClient();
  const { profile, refreshProfile } = useAuth();
  const cash = profile?.cash_balance ?? 0;

  const configQ = useQuery({ queryKey: ["agentConfig"], queryFn: getAgentConfig });
  const holdingsQ = useQuery({ queryKey: ["agentHoldings"], queryFn: getAgentHoldings });
  const decisionsQ = useQuery({ queryKey: ["agentDecisions"], queryFn: getAgentDecisions });
  const snapshotsQ = useQuery({ queryKey: ["agentSnapshots"], queryFn: getAgentSnapshots });
  // S&P 500 benchmark for the performance chart: one fetch per load, reused
  // across range toggles (the chart slices it locally). 1h cache; never blocks
  // the chart if it fails.
  const spyQ = useQuery({
    queryKey: ["spyBenchmark"],
    queryFn: () => getCandles("SPY", "1Y"),
    staleTime: 60 * 60_000,
    retry: 1,
    enabled: (snapshotsQ.data?.length ?? 0) >= 1,
  });
  const config = configQ.data;

  const agentHoldings = holdingsQ.data ?? [];
  const symbols = useMemo(() => agentHoldings.map((h) => h.symbol), [agentHoldings]);
  const quotesQ = useQuotes(symbols);
  const quotes = quotesQ.data;
  const pricesReady = agentHoldings.length === 0 || quotesQ.isSuccess;

  // Agent value = agent_cash + Σ(qty × live price). Return vs the amount allocated.
  const agentCash = config?.agent_cash ?? 0;
  const allocated = config?.allocated_total ?? 0;
  const holdingsValue = useMemo(
    () => agentHoldings.reduce((sum, h) => sum + quoteOf(quotes, h.symbol).price * h.quantity, 0),
    [agentHoldings, quotes],
  );
  const totalValue = agentCash + holdingsValue;
  const retAbs = totalValue - allocated;
  const retPct = allocated > 0 ? (retAbs / allocated) * 100 : 0;

  const updateMut = useMutation({
    mutationFn: updateAgentConfig,
    onSuccess: (cfg) => qc.setQueryData(["agentConfig"], cfg),
    onError: (e: Error) => toast.error(e.message || "Couldn't save that setting."),
  });

  const runMut = useMutation({
    mutationFn: runAgentThinker,
    onSuccess: async (r) => {
      await Promise.all([
        refreshProfile(),
        qc.invalidateQueries({ queryKey: ["agentConfig"] }),
        qc.invalidateQueries({ queryKey: ["agentHoldings"] }),
        qc.invalidateQueries({ queryKey: ["agentDecisions"] }),
      ]);
      if (!r.ran) {
        toast.message("Agent didn't trade", { description: r.reason });
        return;
      }
      const n = r.executed?.length ?? 0;
      toast.success(`Agent ran (${r.aiUsed ? "AI + quant" : "quant only"})`, {
        description: n > 0 ? `${n} trade${n === 1 ? "" : "s"} · held ${r.held?.length ?? 0} within drift bands.` : "No trades needed — portfolio within drift bands.",
      });
    },
    onError: (e: Error) => toast.error(e.message || "The agent run failed."),
  });

  const watchdogMut = useMutation({
    mutationFn: runAgentWatchdog,
    onSuccess: async (r) => {
      await Promise.all([
        refreshProfile(),
        qc.invalidateQueries({ queryKey: ["agentConfig"] }),
        qc.invalidateQueries({ queryKey: ["agentHoldings"] }),
        qc.invalidateQueries({ queryKey: ["agentDecisions"] }),
      ]);
      if (!r.ran) {
        toast.message("Watchdog didn't run", { description: r.reason });
        return;
      }
      const sells = r.sells ?? 0;
      toast.success("Watchdog ran", {
        description:
          sells > 0
            ? `${sells} protective sell${sells === 1 ? "" : "s"} · ${r.ratchets ?? 0} stop${(r.ratchets ?? 0) === 1 ? "" : "s"} raised across ${r.checked} holding${r.checked === 1 ? "" : "s"}.`
            : `No stops breached. ${r.ratchets ?? 0} stop${(r.ratchets ?? 0) === 1 ? "" : "s"} raised across ${r.checked} holding${r.checked === 1 ? "" : "s"}.`,
      });
    },
    onError: (e: Error) => toast.error(e.message || "The watchdog run failed."),
  });

  const [amount, setAmount] = useState(1000);
  const fundMut = useMutation({
    mutationFn: (amt: number) => fundAgent(amt),
    onSuccess: async (r, amt) => {
      await Promise.all([refreshProfile(), qc.invalidateQueries({ queryKey: ["agentConfig"] })]);
      toast.success(amt >= 0 ? `Funded ${fmtUSD(amt)} to the agent` : `Withdrew ${fmtUSD(-amt)} to your main account`, {
        description: `Agent cash now ${fmtUSD(r.agentCash)} · Main cash ${fmtUSD(r.cashBalance)}`,
      });
    },
    onError: (e: Error) => toast.error(e.message || "That transfer couldn't be completed."),
  });

  if (configQ.isLoading) {
    return <div className="py-16"><LoadingState label="Loading your agent…" /></div>;
  }
  if (configQ.isError || !config) {
    return <div className="py-16"><ErrorState message={(configQ.error as Error)?.message} /></div>;
  }

  const amt = Math.max(0, Math.floor(amount || 0));
  const holdingsCount = holdingsQ.data?.length ?? 0;
  const fundDisabled = fundMut.isPending || amt <= 0 || amt > cash;
  const withdrawDisabled = fundMut.isPending || amt <= 0 || amt > config.agent_cash;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <Bot className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Portfolio Agent</h1>
          <p className="text-sm text-muted-foreground">An AI that manages a separate sub-portfolio of your virtual cash.</p>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="flex items-start gap-3 rounded-lg border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-4 py-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-warning,#d97706)]" />
        <p className="text-sm text-foreground">
          <span className="font-semibold">Educational simulation.</span> The agent trades virtual money only and can lose it. This is not financial advice.
        </p>
      </div>

      {/* Summary header — agent value, return vs allocated, invested/cash split */}
      {(allocated > 0 || totalValue > 0) && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryStat label="Agent value" value={pricesReady ? fmtUSD(totalValue) : "—"} sub={`${agentHoldings.length} position${agentHoldings.length === 1 ? "" : "s"}`} />
          <SummaryStat
            label="Total return"
            value={pricesReady ? `${retAbs >= 0 ? "+" : "−"}${fmtUSD(Math.abs(retAbs))}` : "—"}
            sub={pricesReady ? `${fmtPct(retPct)} vs ${fmtUSD(allocated)} allocated` : ""}
            tone={retAbs >= 0 ? "gain" : "loss"}
          />
          <SummaryStat label="Invested" value={pricesReady ? fmtUSD(holdingsValue) : "—"} sub="In positions" />
          <SummaryStat label="Cash" value={fmtUSD(agentCash)} sub="Uninvested, ready to deploy" />
        </div>
      )}

      {/* Run engine */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-medium">Run the agent now</p>
            <p className="text-xs text-muted-foreground">
              Manually trigger one decision cycle (quant screen + AI news read → trades into the agent sub-portfolio). It'll run automatically on a schedule later.
            </p>
          </div>
          <Button
            className="gap-2"
            disabled={runMut.isPending || !config.enabled || config.agent_cash <= 0}
            onClick={() => runMut.mutate()}
          >
            <Bot className="h-4 w-4" /> {runMut.isPending ? "Thinking…" : "Run agent now"}
          </Button>
        </CardContent>
      </Card>

      {/* Watchdog (protective trailing stops) */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-medium">Run the risk watchdog</p>
            <p className="text-xs text-muted-foreground">
              Checks live prices for held positions, raises each volatility-sized trailing stop, and protectively sells any holding that breaks below its stop. No AI, no re-buying — proceeds stay in the agent. It'll run frequently on a schedule later.
            </p>
          </div>
          <Button
            variant="outline"
            className="gap-2"
            disabled={watchdogMut.isPending || !config.enabled || holdingsCount === 0}
            onClick={() => watchdogMut.mutate()}
          >
            <ShieldAlert className="h-4 w-4" /> {watchdogMut.isPending ? "Checking…" : "Run watchdog"}
          </Button>
        </CardContent>
      </Card>
      {config.enabled && holdingsCount === 0 && (
        <p className="-mt-3 text-xs text-muted-foreground">The watchdog activates once the agent holds positions.</p>
      )}
      {(!config.enabled || config.agent_cash <= 0) && (
        <p className="-mt-3 text-xs text-muted-foreground">
          {config.agent_cash <= 0 ? "Fund the agent" : "Activate the agent"} to enable a run.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Settings */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Agent settings</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            {/* Activate */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Activate agent</p>
                <p className="text-xs text-muted-foreground">Activation takes effect once the engine is live (coming soon).</p>
              </div>
              <Switch checked={config.enabled} disabled={updateMut.isPending} onCheckedChange={(v) => updateMut.mutate({ enabled: v })} />
            </div>

            {/* Risk */}
            <div className="space-y-2">
              <Label>Risk level</Label>
              <div className="grid gap-2">
                {RISKS.map((r) => (
                  <button
                    key={r.id}
                    disabled={updateMut.isPending}
                    onClick={() => updateMut.mutate({ risk_level: r.id })}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                      config.risk_level === r.id ? "border-primary bg-primary/10" : "border-border hover:bg-accent/50",
                    )}
                  >
                    <div className="text-sm font-medium">{r.label}</div>
                    <div className="text-xs text-muted-foreground">{r.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Mode */}
            <div className="space-y-2">
              <Label>Mode</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    disabled={updateMut.isPending}
                    onClick={() => updateMut.mutate({ mode: m.id })}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                      config.mode === m.id ? "border-primary bg-primary/10" : "border-border hover:bg-accent/50",
                    )}
                  >
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-muted-foreground">{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Funding */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Wallet className="h-4 w-4" /> Fund the agent</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Available" value={fmtUSD(cash)} hint="Your virtual cash" />
              <Stat label="Agent cash" value={fmtUSD(config.agent_cash)} hint="Uninvested" />
              <Stat label="Allocated" value={fmtUSD(config.allocated_total)} hint="Total moved in" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="amt">Amount (USD)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input id="amt" type="number" min={0} step={100} value={amount} onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))} className="pl-7 tabular" />
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[1000, 5000, 10000].map((a) => (
                  <button key={a} onClick={() => setAmount(a)} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-[color:var(--color-primary)]/50 hover:text-foreground">
                    {fmtUSD(a)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button className="gap-2" disabled={fundDisabled} onClick={() => fundMut.mutate(amt)}>
                <ArrowDownToLine className="h-4 w-4" /> Fund agent
              </Button>
              <Button variant="outline" className="gap-2" disabled={withdrawDisabled} onClick={() => fundMut.mutate(-amt)}>
                <ArrowUpFromLine className="h-4 w-4" /> Withdraw to main
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">Funding moves virtual cash between your main account and the agent. No real money is involved.</p>
          </CardContent>
        </Card>
      </div>

      {/* Agent holdings — live values, weights, P&L, and the watchdog's stop levels */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Agent holdings</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {holdingsQ.isLoading ? (
            <LoadingState label="Loading…" />
          ) : holdingsQ.isError ? (
            <ErrorState message={(holdingsQ.error as Error)?.message} />
          ) : agentHoldings.length === 0 ? (
            <EmptyState icon={Wallet} title="No agent positions yet" description="Fund and activate the agent, then run it — the positions it opens will appear here." />
          ) : quotesQ.isError ? (
            <ErrorState message="Couldn't load live prices. Please try again in a moment." />
          ) : !pricesReady ? (
            <LoadingState label="Loading live prices…" />
          ) : (
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="py-3 font-medium text-right">Qty</th>
                  <th className="py-3 font-medium text-right">Avg cost</th>
                  <th className="py-3 font-medium text-right">Price</th>
                  <th className="py-3 font-medium text-right">Market value</th>
                  <th className="py-3 font-medium text-right">Weight</th>
                  <th className="py-3 font-medium text-right">P&L</th>
                  <th className="px-4 py-3 font-medium text-right">Trailing stop</th>
                </tr>
              </thead>
              <tbody>
                {agentHoldings.map((h) => {
                  const q = quoteOf(quotes, h.symbol);
                  const mv = q.price * h.quantity;
                  const pl = (q.price - h.avg_cost) * h.quantity;
                  const up = pl >= 0;
                  const weight = holdingsValue > 0 ? (mv / holdingsValue) * 100 : 0;
                  const stop = h.trailing_stop_price;
                  const cushion = stop != null && q.price > 0 ? ((q.price - stop) / q.price) * 100 : null;
                  return (
                    <tr key={h.symbol} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-semibold">{q.symbol}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[160px]">{q.name}</div>
                      </td>
                      <td className="py-3 text-right tabular">{h.quantity}</td>
                      <td className="py-3 text-right tabular">{fmtUSD(h.avg_cost)}</td>
                      <td className="py-3 text-right tabular">{fmtUSD(q.price)}</td>
                      <td className="py-3 text-right tabular">{fmtUSD(mv)}</td>
                      <td className="py-3 text-right tabular text-muted-foreground">{weight.toFixed(1)}%</td>
                      <td className={cn("py-3 text-right tabular font-medium", up ? "text-[color:var(--color-gain)]" : "text-[color:var(--color-loss)]")}>
                        {up ? "+" : "−"}{fmtUSD(Math.abs(pl))} <span className="text-xs opacity-80">({fmtPct(h.avg_cost > 0 ? ((q.price - h.avg_cost) / h.avg_cost) * 100 : 0)})</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular">
                        {stop != null ? (
                          <>
                            <div className="flex items-center justify-end gap-1">
                              <ShieldCheck className="h-3.5 w-3.5 text-[color:var(--color-primary)]" />
                              {fmtUSD(stop)}
                            </div>
                            {cushion != null && (
                              <div className={cn("text-xs", cushion >= 0 ? "text-muted-foreground" : "text-[color:var(--color-loss)]")}>
                                {cushion >= 0 ? `${cushion.toFixed(1)}% cushion` : "below stop"}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Performance */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><LineChart className="h-4 w-4" /> Performance</CardTitle>
          </CardHeader>
          <CardContent>
            {allocated > 0 || totalValue > 0 ? (
              <>
                <PortfolioValueChart
                  snapshots={snapshotsQ.data ?? []}
                  liveTotal={totalValue}
                  baseline={allocated}
                  loading={snapshotsQ.isLoading}
                  error={snapshotsQ.isError ? (snapshotsQ.error as Error)?.message : undefined}
                  height={260}
                  benchmark={{ series: (spyQ.data ?? []).map((c) => ({ t: c.t, close: c.close })), loading: spyQ.isLoading, error: spyQ.isError }}
                />
                <p className="mt-2 text-[11px] text-muted-foreground">Dashed line = amount allocated ({fmtUSD(allocated)}). The dashed grey line is the S&amp;P 500 (SPY), indexed to your agent's value at the start of the window.</p>
              </>
            ) : (
              <div className="p-0"><EmptyState icon={LineChart} title="No performance yet" description="Day-over-day growth vs. the amount you allocated will appear once you fund and run the agent." /></div>
            )}
          </CardContent>
        </Card>

        {/* Decision log */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ListTree className="h-4 w-4" /> Decision log</CardTitle></CardHeader>
          <CardContent className="p-0">
            {decisionsQ.isLoading ? (
              <LoadingState label="Loading…" />
            ) : decisionsQ.isError ? (
              <ErrorState message={(decisionsQ.error as Error)?.message} />
            ) : (decisionsQ.data ?? []).length === 0 ? (
              <EmptyState icon={ListTree} title="No decisions yet" description="The agent explains every buy, protective sell, and rebalance here in plain English." />
            ) : (
              <div className="max-h-[420px] overflow-y-auto divide-y divide-border/60">
                {(decisionsQ.data ?? []).map((d) => <DecisionRow key={d.id} d={d} />)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const ACTION_META: Record<string, { label: string; icon: typeof ShoppingCart; cls: string }> = {
  buy: { label: "Buy", icon: ShoppingCart, cls: "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]" },
  sell: { label: "Protective sell", icon: ShieldCheck, cls: "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]" },
  trim: { label: "Trim / exit", icon: Scissors, cls: "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]" },
  rebalance: { label: "Rebalance", icon: RefreshCw, cls: "bg-[color:var(--color-primary)]/15 text-[color:var(--color-primary)]" },
  hold: { label: "Hold", icon: PauseCircle, cls: "bg-muted text-muted-foreground" },
  watchdog: { label: "Watchdog", icon: Eye, cls: "bg-muted text-muted-foreground" },
};

function DecisionRow({ d }: { d: AgentDecision }) {
  const meta = ACTION_META[d.action] ?? { label: d.action, icon: ListTree, cls: "bg-muted text-muted-foreground" };
  const Icon = meta.icon;
  const accent = d.action === "buy" ? "border-l-[color:var(--color-gain)]" : d.action === "sell" || d.action === "trim" ? "border-l-[color:var(--color-loss)]" : d.action === "rebalance" ? "border-l-[color:var(--color-primary)]" : "border-l-border";
  return (
    <div className={cn("border-l-2 px-4 py-3", accent)}>
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider", meta.cls)}>
          <Icon className="h-3 w-3" /> {meta.label}
        </span>
        {d.symbol && <span className="text-sm font-semibold">{d.symbol}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground tabular">{new Date(d.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      </div>
      {d.rationale && <p className="mt-1.5 text-sm text-foreground/90">{d.rationale}</p>}
    </div>
  );
}

function SummaryStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "gain" | "loss" }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular", tone === "gain" && "text-[color:var(--color-gain)]", tone === "loss" && "text-[color:var(--color-loss)]")}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold tabular">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
