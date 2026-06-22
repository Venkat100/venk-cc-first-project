import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState, ErrorState } from "@/components/DataStates";
import { getAgentConfig, updateAgentConfig, fundAgent, runAgentThinker } from "@/lib/agent/api";
import { getAgentHoldings, getAgentDecisions } from "@/lib/agent/queries";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import type { RiskLevel, AgentMode } from "@/lib/supabase/types";
import { toast } from "sonner";
import { Bot, ShieldAlert, Wallet, LineChart, ListTree, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";

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
  const config = configQ.data;

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
        description: n > 0 ? `Opened ${n} position${n === 1 ? "" : "s"}. ${r.commentary ?? ""}`.trim() : "No trades met the guardrails this run.",
      });
    },
    onError: (e: Error) => toast.error(e.message || "The agent run failed."),
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

      {/* Holdings / Performance / Decision log — empty until the engine runs */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Agent holdings</CardTitle></CardHeader>
        <CardContent className="p-0">
          {holdingsQ.isLoading ? (
            <LoadingState label="Loading…" />
          ) : holdingsQ.isError ? (
            <ErrorState message={(holdingsQ.error as Error)?.message} />
          ) : (holdingsQ.data ?? []).length === 0 ? (
            <EmptyState icon={Wallet} title="No agent positions yet" description="Fund and activate the agent — once the engine is live, the positions it opens will appear here." />
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">{(holdingsQ.data ?? []).length} positions</div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><LineChart className="h-4 w-4" /> Performance</CardTitle></CardHeader>
          <CardContent className="p-0">
            <EmptyState icon={LineChart} title="No performance yet" description="Day-over-day growth vs. the amount you allocated will appear once the agent starts trading." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ListTree className="h-4 w-4" /> Decision log</CardTitle></CardHeader>
          <CardContent className="p-0">
            {decisionsQ.isLoading ? (
              <LoadingState label="Loading…" />
            ) : decisionsQ.isError ? (
              <ErrorState message={(decisionsQ.error as Error)?.message} />
            ) : (decisionsQ.data ?? []).length === 0 ? (
              <EmptyState icon={ListTree} title="No decisions yet" description="The agent will explain every buy, sell, and hold here in plain English once it starts trading." />
            ) : (
              <div className="px-4 py-3 text-sm text-muted-foreground">{(decisionsQ.data ?? []).length} decisions</div>
            )}
          </CardContent>
        </Card>
      </div>
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
