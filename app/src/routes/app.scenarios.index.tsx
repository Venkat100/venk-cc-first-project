// Scenario Challenges (PLAN.md §6 step 9, B5) — the picker page. Own
// dedicated page, same precedent as Margin/Options/Journal/Coach: this is a
// genuinely different "mode" of use (a multi-session challenge, not a
// glance at current state).
//
// Lives as the INDEX child of the app.scenarios layout (see app.scenarios.tsx)
// rather than directly on app.scenarios.tsx — that split is required so the
// run-detail page (app.scenarios.$runId.tsx, also a child of the layout)
// renders on its own instead of underneath this picker's own JSX.
//
// UNLOCKED for now — PLAN.md §C gates this as paid in step 11. Deliberately
// NOT wrapped in UnlockGate (that's step 8's mechanism for options/margin
// comprehension, not a payment gate) — entitlement will slot in here later
// without touching the scenario engine itself.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState, ErrorState } from "@/components/DataStates";
import { listScenarios } from "@/lib/scenarios/catalog";
import { getScenarioRuns } from "@/lib/scenarios/queries";
import { startScenarioRun } from "@/lib/scenarios/api";
import { fmtUSD } from "@/lib/mockData";
import { History, Play, RotateCcw, Trophy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/scenarios/")({
  head: () => ({ meta: [{ title: "Scenario Challenges · PaperTrader" }] }),
  component: ScenariosPage,
});

function prettyDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function ScenariosPage() {
  const navigate = useNavigate();
  const runsQ = useQuery({ queryKey: ["scenarioRuns"], queryFn: getScenarioRuns });

  const startMut = useMutation({
    mutationFn: (scenarioId: string) => startScenarioRun(scenarioId),
    onSuccess: (run) => navigate({ to: "/app/scenarios/$runId", params: { runId: run.id } }),
    onError: (e: Error) => toast.error(e.message || "Couldn't start that scenario."),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <History className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scenario Challenges</h1>
          <p className="text-sm text-muted-foreground">Trade through real market history, day by day — without knowing what happens next.</p>
        </div>
      </div>

      {runsQ.isLoading ? (
        <Card><CardContent className="p-0"><LoadingState label="Loading your scenario history…" /></CardContent></Card>
      ) : runsQ.isError ? (
        <Card><CardContent className="p-0"><ErrorState message={(runsQ.error as Error)?.message} /></CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {listScenarios().map((scenario) => {
            const runs = (runsQ.data ?? []).filter((r) => r.scenario_id === scenario.id);
            const activeRun = runs.find((r) => r.status === "active");
            const completedRuns = runs.filter((r) => r.status === "completed");
            const latestCompleted = completedRuns[0];

            return (
              <Card key={scenario.id} className="flex flex-col">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{scenario.title}</CardTitle>
                  <p className="text-xs text-muted-foreground">{scenario.tagline}</p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p>{prettyDate(scenario.startDate)} → {prettyDate(scenario.endDate)}</p>
                    <p>Starting stake: <span className="tabular text-foreground font-medium">{fmtUSD(scenario.startingCash)}</span></p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {scenario.symbols.map((s) => (
                      <span key={s.symbol} className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{s.symbol}</span>
                    ))}
                    <span className="rounded-full border border-[color:var(--color-primary)]/40 bg-[color:var(--color-primary)]/10 px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-primary)]">{scenario.benchmarkSymbol} benchmark</span>
                  </div>

                  {completedRuns.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">{completedRuns.length} completed attempt{completedRuns.length === 1 ? "" : "s"}</p>
                  )}

                  <div className="mt-auto flex flex-col gap-2 pt-2">
                    {activeRun ? (
                      <Button className="w-full gap-2" onClick={() => navigate({ to: "/app/scenarios/$runId", params: { runId: activeRun.id } })}>
                        <Play className="h-4 w-4" /> Resume — step {activeRun.step_index + 1}
                      </Button>
                    ) : (
                      <Button className="w-full gap-2" disabled={startMut.isPending} onClick={() => startMut.mutate(scenario.id)}>
                        <Play className="h-4 w-4" /> {completedRuns.length > 0 ? "Start new attempt" : "Start Challenge"}
                      </Button>
                    )}
                    {latestCompleted && (
                      <Button variant="outline" className="w-full gap-2" onClick={() => navigate({ to: "/app/scenarios/$runId", params: { runId: latestCompleted.id } })}>
                        <Trophy className="h-4 w-4" /> View last results
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground sm:text-sm">
        <RotateCcw className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Each scenario is its own sandbox — a separate stake and separate positions from your real paper account. Nothing you do here touches your main portfolio.</p>
      </div>
    </div>
  );
}
