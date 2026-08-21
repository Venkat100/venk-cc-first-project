// Underfunded banner (issue #38b, FIXED 2026-08-21 — see app.agent.tsx's
// header for the full incident). Extracted into its own component for the
// same reason AgentActivityStatusLine was: a plain-props presentational
// component is cheaply testable without mounting the whole route (react
// query, auth context, live price hooks). Takes an already-computed verdict
// — it does NOT decide whether the account is underfunded itself, only how
// to render that decision — the LIVE computation (current total value vs.
// suggestedMinFunding(riskLevel)) lives in app.agent.tsx / guardrails.ts.

import { AlertTriangle } from "lucide-react";
import { fmtUSD } from "@/lib/mockData";
import type { RiskLevel } from "@/lib/supabase/types";

export function AgentUnderfundedBanner({ isUnderfunded, riskLevel, suggestedMin }: { isUnderfunded: boolean; riskLevel: RiskLevel; suggestedMin: number }) {
  if (!isUnderfunded) return null;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[color:var(--color-warning,#b45309)]/40 bg-[color:var(--color-warning,#b45309)]/10 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-warning,#d97706)]" />
      <p className="text-sm text-foreground">
        <span className="font-semibold">This account is too small to invest.</span> Every target position would fall below the minimum trade size for a {riskLevel} portfolio.
        {` Consider funding at least ${fmtUSD(suggestedMin)}.`}
      </p>
    </div>
  );
}
