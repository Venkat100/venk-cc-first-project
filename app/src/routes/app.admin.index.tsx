// Admin console overview (PLAN.md §6 step 10, B4) — usage/cost dashboard +
// system health. Lives as the index child of app.admin.tsx's layout (same
// split reasoning as that file's own header comment).

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { getUsageStats, getSystemHealth, getIdleAgents } from "@/lib/admin/api";
import { summarizeIdleReason, NEVER_TRADED_IDLE_DAYS, WENT_QUIET_DAYS } from "@/lib/agent/activityStatus";
import { fmtUSD } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, Info, Bot } from "lucide-react";

export const Route = createFileRoute("/app/admin/")({
  component: AdminOverviewPage,
});

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="tabular mt-1 text-2xl font-semibold">{value}</p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function AdminOverviewPage() {
  const statsQ = useQuery({ queryKey: ["adminUsageStats"], queryFn: () => getUsageStats(30) });
  const healthQ = useQuery({ queryKey: ["adminSystemHealth"], queryFn: getSystemHealth, refetchInterval: 60_000 });
  const idleAgentsQ = useQuery({ queryKey: ["adminIdleAgents"], queryFn: getIdleAgents });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Bot className="h-4 w-4" /> Idle agents</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex items-start gap-2 border-b border-border bg-surface px-4 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Funded, enabled agents with no real trade (buy/trim/sell) in the last {WENT_QUIET_DAYS} days, or none at all {NEVER_TRADED_IDLE_DAYS}+ days after their first run — AGENT-AUDIT.md Part 8. This is an activity fact, not a diagnosis: it may mean the agent is correctly holding through a calm market, or something else — the data can't yet tell those apart. Worth a look, not an alarm.
            </p>
          </div>
          {idleAgentsQ.isLoading ? (
            <LoadingState label="Checking…" />
          ) : idleAgentsQ.isError ? (
            <ErrorState message={(idleAgentsQ.error as Error)?.message} />
          ) : idleAgentsQ.data!.agents.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No funded, enabled agent is currently past either threshold.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {idleAgentsQ.data!.agents.map((a) => (
                <div key={a.userId} className="flex flex-col gap-1 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{a.email}</span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{a.riskLevel}</span>
                  </span>
                  <span className="text-xs text-muted-foreground sm:text-right">{summarizeIdleReason(a.status)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">System health</CardTitle>
        </CardHeader>
        <CardContent>
          {healthQ.isLoading ? (
            <LoadingState label="Checking…" />
          ) : healthQ.isError ? (
            <ErrorState message={(healthQ.error as Error)?.message} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <HealthRow label="Database" ok={healthQ.data!.checks.database.ok} detail={healthQ.data!.checks.database.error} />
              <HealthRow label="Market data" ok={healthQ.data!.checks.marketData.ok} detail={healthQ.data!.checks.marketData.error} />
              {Object.entries(healthQ.data!.checks.crons).map(([name, c]) => (
                <HealthRow key={name} label={`Cron: ${name}`} ok={c.ok} detail={c.error ?? (c.ageHours != null ? `Last ran ${c.ageHours}h ago` : undefined)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {statsQ.isLoading ? (
        <Card><CardContent className="p-0"><LoadingState label="Loading usage…" /></CardContent></Card>
      ) : statsQ.isError ? (
        <Card><CardContent className="p-0"><ErrorState message={(statsQ.error as Error)?.message} /></CardContent></Card>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Last {statsQ.data!.windowDays} days. Cost figures are ESTIMATES — call count × an assumed flat rate
              (${statsQ.data!.assumedRates.insightCallUsd.toFixed(2)}/insight call, ${statsQ.data!.assumedRates.agentRunUsd.toFixed(2)}/agent
              run), not metered token usage. Provider-fetch count is real, not estimated.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="AI insight/brief calls"
              value={String(statsQ.data!.insightCalls.total)}
              sub={`${statsQ.data!.insightCalls.byKind.stock} stock · ${statsQ.data!.insightCalls.byKind.brief} brief · ~${fmtUSD(statsQ.data!.insightCalls.estimatedCostUsd)}`}
            />
            <StatCard
              label="Agent runs"
              value={String(statsQ.data!.agentRuns.total)}
              sub={`~${fmtUSD(statsQ.data!.agentRuns.estimatedCostUsd)} (upper bound)`}
            />
            <StatCard
              label="Provider fetches"
              value={String(statsQ.data!.providerFetches.total)}
              sub="Real cache-miss count"
            />
            <StatCard
              label="Rate-limit rejections"
              value={String(statsQ.data!.rateLimitRejections.total)}
              sub={`${statsQ.data!.rateLimitRejections.byReason.burst} burst · ${statsQ.data!.rateLimitRejections.byReason.daily} daily`}
            />
            <StatCard
              label="Real accounts"
              value={String(statsQ.data!.accountCounts.real)}
              sub={`${statsQ.data!.accountCounts.test} test accounts excluded`}
            />
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{statsQ.data!.accountCounts.note}</p>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Per-user cost outliers (top 20)</CardTitle></CardHeader>
            <CardContent className="p-0">
              {statsQ.data!.perUserCost.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No attributable AI usage in this window.</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {statsQ.data!.perUserCost.map((u) => (
                    <div key={u.userId} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{u.email}</span>
                        {u.isTestAccount && (
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">test</span>
                        )}
                      </span>
                      <span className="tabular shrink-0 text-muted-foreground">
                        {u.insightCalls} insight · {u.agentRuns} agent · ~{fmtUSD(u.estimatedCostUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function HealthRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-gain)]" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-loss)]" />}
      <div className={cn("min-w-0", !ok && "text-[color:var(--color-loss)]")}>
        <p className="font-medium">{label}</p>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}
