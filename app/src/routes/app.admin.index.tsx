// Admin console overview (PLAN.md §6 step 10, B4) — usage/cost dashboard +
// system health. Lives as the index child of app.admin.tsx's layout (same
// split reasoning as that file's own header comment).

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { getUsageStats, getSystemHealth, getIdleAgents, listTestAccounts, deleteTestAccounts, testSentryDelivery } from "@/lib/admin/api";
import { summarizeIdleReason, NEVER_TRADED_IDLE_DAYS, WENT_QUIET_DAYS } from "@/lib/agent/activityStatus";
import { formatInstant } from "@/lib/format/datetime";
import { fmtUSD } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Info, Bot, FlaskConical, Trash2, Send } from "lucide-react";

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
  const qc = useQueryClient();
  const statsQ = useQuery({ queryKey: ["adminUsageStats"], queryFn: () => getUsageStats(30) });
  const healthQ = useQuery({ queryKey: ["adminSystemHealth"], queryFn: getSystemHealth, refetchInterval: 60_000 });
  const idleAgentsQ = useQuery({ queryKey: ["adminIdleAgents"], queryFn: getIdleAgents });
  const testAccountsQ = useQuery({ queryKey: ["adminTestAccounts"], queryFn: listTestAccounts });

  const [confirmDeleteTestOpen, setConfirmDeleteTestOpen] = useState(false);
  const deleteTestMut = useMutation({
    mutationFn: () => deleteTestAccounts((testAccountsQ.data ?? []).map((a) => a.userId)),
    onSuccess: async (res) => {
      setConfirmDeleteTestOpen(false);
      await Promise.all([qc.invalidateQueries({ queryKey: ["adminTestAccounts"] }), qc.invalidateQueries({ queryKey: ["adminUsageStats"] }), qc.invalidateQueries({ queryKey: ["adminIdleAgents"] })]);
      if (res.failed.length === 0) {
        toast.success(`Deleted ${res.deleted.length} test account${res.deleted.length === 1 ? "" : "s"}`);
      } else {
        toast.message(`Deleted ${res.deleted.length}, ${res.failed.length} failed`, { description: res.failed.map((f) => f.email).join(", ") });
      }
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't delete test accounts.");
      setConfirmDeleteTestOpen(false);
    },
  });
  const testAccounts = testAccountsQ.data ?? [];
  const testAccountsFunded = testAccounts.filter((a) => a.agentFunded > 0).length;

  const testSentryMut = useMutation({
    mutationFn: testSentryDelivery,
    onSuccess: (res) => {
      if (!res.sentryConfigured) {
        toast.message("SENTRY_DSN not configured", { description: "Nothing to test — set it in Vercel first." });
        return;
      }
      toast.success("Test event sent to Sentry", { description: `marker=${res.marker} · event ${res.eventId} — confirm it landed in the Sentry dashboard.` });
    },
    onError: (e: Error) => toast.error(e.message || "Couldn't send the test event."),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Test accounts in production</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex items-start gap-2 border-b border-border bg-surface px-4 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Every account matching the reserved test-domain pattern (<code>@example.org</code>/<code>.com</code>/<code>.net</code>, RFC 2606 — no real signup can ever use these). <code>createTestUser()</code> now refuses to create an account outside this pattern, so new drift shouldn't recur — this list is for cleaning up what's already here.
            </p>
          </div>
          {testAccountsQ.isLoading ? (
            <LoadingState label="Checking…" />
          ) : testAccountsQ.isError ? (
            <ErrorState message={(testAccountsQ.error as Error)?.message} />
          ) : testAccounts.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No test accounts currently in production.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <p className="text-sm text-foreground">
                  <span className="font-semibold">{testAccounts.length}</span> test account{testAccounts.length === 1 ? "" : "s"}
                  {testAccountsFunded > 0 && <span className="text-muted-foreground"> ({testAccountsFunded} with a funded agent)</span>}
                  <span className="text-muted-foreground">, oldest {formatInstant(testAccounts[0].createdAt)}.</span>
                </p>
                <Button variant="destructive" size="sm" className="gap-2" onClick={() => setConfirmDeleteTestOpen(true)}>
                  <Trash2 className="h-4 w-4" /> Delete all {testAccounts.length}
                </Button>
              </div>
              <div className="max-h-72 divide-y divide-border/60 overflow-y-auto">
                {testAccounts.map((a) => (
                  <div key={a.userId} className="flex flex-col gap-1 px-4 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span className="truncate">{a.email}</span>
                    <span className="text-xs text-muted-foreground sm:text-right">
                      {a.agentFunded > 0 ? `agent funded ${fmtUSD(a.agentFunded)} · ` : ""}
                      {a.hasHoldings ? "holdings · " : ""}
                      {a.hasTransactions ? "transactions · " : ""}
                      {formatInstant(a.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

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
        {!healthQ.isLoading && !healthQ.isError && (
          <>
            <CardHeader className="pb-2 pt-0">
              <CardTitle className="text-sm text-muted-foreground font-medium">Configuration — features that no-op silently when unset</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 2026-08-17: SENTRY_DSN sat unset in Vercel Production for a
                 week with nothing announcing it — this section, and the
                 config field on every /api/health call, is the structural
                 fix. Neutral styling on purpose (not red/green pass-fail):
                 every one of these is genuinely optional by design, so an
                 unconfigured state is a FACT to see, not a failure. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <ConfigRow label="Sentry (server)" configured={healthQ.data!.config.sentryServer} />
                <ConfigRow label="Sentry (client)" configured={healthQ.data!.config.sentryClient} />
                <ConfigRow label="Agent model" configured value={healthQ.data!.config.agentModel} />
              </div>
              <Button variant="outline" size="sm" className="gap-2" disabled={testSentryMut.isPending} onClick={() => testSentryMut.mutate()}>
                <Send className="h-3.5 w-3.5" /> {testSentryMut.isPending ? "Sending…" : "Send test error to Sentry"}
              </Button>
            </CardContent>
          </>
        )}
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

      <ConfirmDialog
        open={confirmDeleteTestOpen}
        onOpenChange={setConfirmDeleteTestOpen}
        title={`Delete ${testAccounts.length} test account${testAccounts.length === 1 ? "" : "s"}?`}
        consequence={`This permanently deletes every listed @example.org/.com/.net account and everything tied to it — holdings, trades, agent data, everything. The server re-verifies each one still matches the test-email pattern before deleting; this cannot remove a real account. This cannot be undone.`}
        detail={
          <div className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {testAccounts.map((a) => <div key={a.userId} className="truncate text-muted-foreground">{a.email}</div>)}
          </div>
        }
        confirmLabel={`Delete ${testAccounts.length} account${testAccounts.length === 1 ? "" : "s"}`}
        variant="destructive"
        requireTypedConfirmation="DELETE"
        loading={deleteTestMut.isPending}
        onConfirm={() => deleteTestMut.mutate()}
      />
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

/** Neutral, not pass/fail — an unconfigured optional integration is a fact
 *  to see, never a red X (see the "Configuration" section's own header
 *  comment for why). `value` overrides the generic "Set"/"Not set" text
 *  when there's a more specific state to show (e.g. a default in use). */
function ConfigRow({ label, configured, value }: { label: string; configured: boolean; value?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={cn("mt-0.5 h-4 w-4 shrink-0 rounded-full", configured ? "bg-[color:var(--color-primary)]/70" : "bg-muted-foreground/40")} />
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{value ?? (configured ? "Set" : "Not set — feature no-ops")}</p>
      </div>
    </div>
  );
}
