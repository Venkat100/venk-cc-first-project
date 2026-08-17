// Plain-English agent activity status — AGENT-AUDIT.md Part 8's pre-launch
// item. Always three FACTS, never a verdict: when the agent last acted,
// what it last decided, when it runs next. See activityStatus.ts's header
// for the hard constraint this component must not violate — no language
// implying health ("healthy," "on track," "nothing to worry about") for
// any state, since Part 8 §3 found we can only prove that for the one
// failure mode already patched elsewhere (the underfunded banner).

import { Clock } from "lucide-react";
import { formatInstant } from "@/lib/format/datetime";
import { computeAgentActivityStatus, nextAgentThinkerRunIso, type MinimalDecision } from "@/lib/agent/activityStatus";

function relativeDaysLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:w-32">{label}</span>
      <span className="text-sm text-foreground">{children}</span>
    </div>
  );
}

export function AgentActivityStatusLine({ decisions, now = new Date() }: { decisions: MinimalDecision[]; now?: Date }) {
  const status = computeAgentActivityStatus(decisions, now);
  const nextRun = formatInstant(nextAgentThinkerRunIso(now), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1.5">
        {status.kind === "not_started" && (
          <Row label="Last trade">The agent hasn't run yet.</Row>
        )}
        {status.kind === "never_traded" && (
          <Row label="Last trade">
            {status.pastThreshold ? `None yet — ${status.sinceDays} day${status.sinceDays === 1 ? "" : "s"} since the agent's first run.` : `None yet — first run was ${relativeDaysLabel(status.sinceDays)}.`}
          </Row>
        )}
        {(status.kind === "active" || status.kind === "quiet") && (
          <Row label="Last trade">
            {status.lastTradeSummary} — {relativeDaysLabel(status.sinceDays)} ({formatInstant(status.lastTradeAt)})
          </Row>
        )}
        {status.kind !== "not_started" && (
          <Row label="Last decision">
            {status.latestRationale ? `“${status.latestRationale}”` : "—"} ({formatInstant(status.latestAt)})
          </Row>
        )}
        <Row label="Next scheduled run">{nextRun}</Row>
      </div>
    </div>
  );
}
