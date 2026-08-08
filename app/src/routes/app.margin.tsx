// Margin (M2) — its own nav page rather than a section bolted onto
// Portfolio/Settings: margin has its own state (enabled/loan/status), its
// own event ledger, and a substantial education block, and it's the
// highest-stakes feature in the app (M1's own words) — it earns a dedicated
// home a user can bookmark/return to, the same way Options got a chain
// browser + positions view rather than living inside the stock-order panel.
//
// UI ONLY: every number here is read verbatim from getMarginStateFn (M1) —
// this file never re-derives equity/buying-power/maintenance math.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LoadingState, ErrorState, EmptyState } from "@/components/DataStates";
import { MarginDisclaimer, MarginExplainer } from "@/components/margin/MarginExplainer";
import { getMarginState, setMarginEnabled, repayMargin, getMarginEvents } from "@/lib/margin/api";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD, fmtPct, fmtQty } from "@/lib/mockData";
import { cn } from "@/lib/utils";
import type { MarginEvent, MarginEventKind } from "@/lib/supabase/types";
import { toast } from "sonner";
import {
  Landmark, ShieldCheck, ShieldOff, ArrowDownToLine, ArrowUpFromLine, Percent,
  AlertTriangle, Siren, Scissors, History, ShieldQuestion,
} from "lucide-react";

export const Route = createFileRoute("/app/margin")({
  head: () => ({ meta: [{ title: "Margin · PaperTrader" }] }),
  component: MarginPage,
});

function MarginPage() {
  const qc = useQueryClient();
  const { refreshProfile } = useAuth();

  const stateQ = useQuery({ queryKey: ["marginState"], queryFn: getMarginState, staleTime: 10_000 });
  const eventsQ = useQuery({ queryKey: ["marginEvents"], queryFn: getMarginEvents });

  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);
  const [confirmRepayOpen, setConfirmRepayOpen] = useState(false);
  const [repayInput, setRepayInput] = useState("0");

  async function refreshAll() {
    await Promise.all([
      refreshProfile(),
      qc.invalidateQueries({ queryKey: ["marginState"] }),
      qc.invalidateQueries({ queryKey: ["marginEvents"] }),
    ]);
  }

  const enableMut = useMutation({
    mutationFn: () => setMarginEnabled(true),
    onSuccess: async () => {
      await refreshAll();
      setConfirmEnableOpen(false);
      toast.success("Margin enabled", { description: "You can now borrow up to 2× your equity. Interest accrues daily." });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't enable margin.");
      setConfirmEnableOpen(false);
    },
  });

  const disableMut = useMutation({
    mutationFn: () => setMarginEnabled(false),
    onSuccess: async () => {
      await refreshAll();
      setConfirmDisableOpen(false);
      toast.success("Margin disabled", { description: "Your buying power is back to just your cash." });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't disable margin.");
      setConfirmDisableOpen(false);
    },
  });

  const repayMut = useMutation({
    mutationFn: (amount: number) => repayMargin(amount),
    onSuccess: async (r) => {
      await refreshAll();
      setConfirmRepayOpen(false);
      setRepayInput("0");
      toast.success(`Repaid ${fmtUSD(r.repaid)}`, { description: `Loan now ${fmtUSD(r.marginLoan)} · Cash now ${fmtUSD(r.cashBalance)}` });
    },
    onError: (e: Error) => {
      toast.error(e.message || "Couldn't repay the loan.");
      setConfirmRepayOpen(false);
    },
  });

  if (stateQ.isLoading) return <div className="py-16"><LoadingState label="Loading your margin account…" /></div>;
  if (stateQ.isError || !stateQ.data) return <div className="py-16"><ErrorState message={(stateQ.error as Error)?.message} /></div>;

  const s = stateQ.data;
  const repayAmt = Number(repayInput) || 0;
  const repayMax = round2(Math.min(s.cashBalance, s.marginLoan));
  const repayDisabled = repayMut.isPending || repayAmt <= 0 || repayAmt > repayMax + 0.005;
  const cushionDollars = round2(s.equity - s.maintenanceRequirement);
  const cushionPct = s.maintenanceRequirement > 0 ? round2(((s.equity - s.maintenanceRequirement) / s.maintenanceRequirement) * 100) : null;
  const totalInterest = round2((eventsQ.data ?? []).filter((e) => e.kind === "interest").reduce((sum, e) => sum + Number(e.amount), 0));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-[color:var(--color-primary)]">
          <Landmark className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Margin</h1>
          <p className="text-sm text-muted-foreground">Borrow against your portfolio to buy more than your cash alone allows.</p>
        </div>
      </div>

      <StatusBanner status={s.marginStatus} enabled={s.marginEnabled} maintenancePct={s.maintenancePct} warningBufferPct={s.warningBufferPct} />

      <MarginDisclaimer />

      {!s.marginEnabled && (
        <Card className="border-[color:var(--color-primary)]/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium">Margin is off</p>
              <p className="text-xs text-muted-foreground">Turn it on to borrow up to 2× your equity. Your buying power right now is just your cash: {fmtUSD(s.buyingPower)}.</p>
            </div>
            <Button className="gap-2" onClick={() => setConfirmEnableOpen(true)}>
              <ShieldCheck className="h-4 w-4" /> Enable margin
            </Button>
          </CardContent>
        </Card>
      )}

      {/* The numbers — every one straight from getMarginStateFn, no re-derivation */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Your margin account</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Num label="Equity" hint="Cash + positions − loan" value={fmtUSD(s.equity)} />
          <Num label="Positions value" hint="Live-priced stock + options" value={fmtUSD(s.positionsValue)} />
          <Num label="Margin loan" hint="What you currently owe" value={fmtUSD(s.marginLoan)} tone={s.marginLoan > 0 ? "loss" : undefined} />
          <Num label="Buying power" hint={s.marginEnabled ? "max(0, 2×equity − positions)" : "= your cash (margin off)"} value={fmtUSD(s.buyingPower)} tone="gain" />
          <Num label="Maintenance requirement" hint={`${s.maintenancePct * 100}% of positions value`} value={fmtUSD(s.maintenanceRequirement)} />
          <Num
            label="Cushion before a call"
            hint="Equity − requirement"
            value={`${cushionDollars >= 0 ? "+" : "−"}${fmtUSD(Math.abs(cushionDollars))}`}
            sub={cushionPct != null ? `${cushionPct >= 0 ? "+" : ""}${cushionPct.toFixed(1)}%` : "No positions yet"}
            tone={cushionDollars >= 0 ? "gain" : "loss"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Percent className="h-4 w-4" /> Interest</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Accrued to date</p>
            <p className="mt-1 text-xl font-semibold tabular">{fmtUSD(totalInterest)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Annual rate</p>
            <p className="mt-1 text-xl font-semibold tabular">{(s.interestRate * 100).toFixed(0)}%</p>
          </div>
          <p className="w-full text-xs text-muted-foreground">Charged daily on your outstanding loan and added to the loan balance — it compounds if left unpaid.</p>
        </CardContent>
      </Card>

      {/* Controls */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Manage</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          {s.marginEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor="repay">Repay loan</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <Input id="repay" type="number" min={0} step="0.01" value={repayInput} onChange={(e) => setRepayInput(e.target.value)} className="tabular pl-6" />
                </div>
                <Button variant="outline" className="shrink-0" disabled={repayMax <= 0} onClick={() => setRepayInput(String(repayMax))}>
                  Repay max ({fmtUSD(repayMax)})
                </Button>
                <Button className="shrink-0" disabled={repayDisabled} onClick={() => setConfirmRepayOpen(true)}>
                  Repay
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Capped at the lesser of your cash ({fmtUSD(s.cashBalance)}) and your loan ({fmtUSD(s.marginLoan)}).</p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 first:border-0 first:pt-0">
            <div>
              <p className="text-sm font-medium">{s.marginEnabled ? "Disable margin" : "Margin"}</p>
              {s.marginEnabled && (
                <p className="text-xs text-muted-foreground">
                  {s.marginLoan > 0 ? `Repay your ${fmtUSD(s.marginLoan)} loan before you can disable margin.` : "Turns off borrowing. Your buying power returns to just your cash."}
                </p>
              )}
            </div>
            {s.marginEnabled ? (
              <Button variant="outline" className="gap-2" disabled={s.marginLoan > 0} onClick={() => setConfirmDisableOpen(true)}>
                <ShieldOff className="h-4 w-4" /> Disable margin
              </Button>
            ) : (
              <Button className="gap-2" onClick={() => setConfirmEnableOpen(true)}>
                <ShieldCheck className="h-4 w-4" /> Enable margin
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Event history */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4" /> Event history</CardTitle></CardHeader>
        <CardContent className="p-0">
          {eventsQ.isLoading ? (
            <LoadingState label="Loading…" />
          ) : eventsQ.isError ? (
            <ErrorState message={(eventsQ.error as Error)?.message} />
          ) : (eventsQ.data ?? []).length === 0 ? (
            <EmptyState icon={ShieldQuestion} title="No margin activity yet" description="Enable margin and every borrow, repay, interest charge, warning, and call will show up here." />
          ) : (
            <div className="max-h-[420px] overflow-y-auto divide-y divide-border/60">
              {(eventsQ.data ?? []).map((e) => <EventRow key={e.id} event={e} />)}
            </div>
          )}
        </CardContent>
      </Card>

      <MarginExplainer interestRatePct={s.interestRate} maintenancePct={s.maintenancePct * 100} warningBufferPct={s.warningBufferPct} />

      {/* Dialogs */}
      <ConfirmDialog
        open={confirmEnableOpen}
        onOpenChange={setConfirmEnableOpen}
        title="Enable margin"
        consequence={`Turn on margin trading? This lets you borrow up to 2× your equity to buy more than your cash alone allows. Interest accrues daily at ${(s.interestRate * 100).toFixed(0)}%, and if your equity falls below the maintenance requirement, positions may be SOLD AUTOMATICALLY to restore it.`}
        confirmLabel="Enable margin"
        variant="destructive"
        loading={enableMut.isPending}
        onConfirm={() => enableMut.mutate()}
      />

      <ConfirmDialog
        open={confirmDisableOpen}
        onOpenChange={setConfirmDisableOpen}
        title="Disable margin"
        consequence="Turn off margin trading? Your buying power will return to just your cash."
        confirmLabel="Disable margin"
        loading={disableMut.isPending}
        onConfirm={() => disableMut.mutate()}
      />

      <ConfirmDialog
        open={confirmRepayOpen}
        onOpenChange={setConfirmRepayOpen}
        title="Repay margin loan"
        consequence={`Repay ${fmtUSD(repayAmt)} of your margin loan?`}
        detail={
          <div className="space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Margin loan</span><span className="tabular font-medium">{fmtUSD(s.marginLoan)} → {fmtUSD(round2(s.marginLoan - repayAmt))}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Cash</span><span className="tabular font-medium">{fmtUSD(s.cashBalance)} → {fmtUSD(round2(s.cashBalance - repayAmt))}</span></div>
          </div>
        }
        confirmLabel="Repay"
        loading={repayMut.isPending}
        onConfirm={() => repayMut.mutate(repayAmt)}
      />
    </div>
  );
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function StatusBanner({ status, enabled, maintenancePct, warningBufferPct }: { status: "ok" | "warning" | "call"; enabled: boolean; maintenancePct: number; warningBufferPct: number }) {
  if (!enabled) return null; // the "margin is off" card right below covers this case
  if (status === "call") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-[color:var(--color-loss)]/50 bg-[color:var(--color-loss)]/10 px-4 py-3.5">
        <Siren className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-loss)]" />
        <div>
          <p className="text-sm font-semibold text-[color:var(--color-loss)]">Margin call</p>
          <p className="mt-0.5 text-sm text-foreground">Your equity is below the maintenance requirement. Positions may be sold automatically to restore it. Repay some of your loan or add cash to avoid further sales.</p>
        </div>
      </div>
    );
  }
  if (status === "warning") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-[color:var(--color-warning,#b45309)]/50 bg-[color:var(--color-warning,#b45309)]/10 px-4 py-3.5">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--color-warning,#d97706)]" />
        <div>
          <p className="text-sm font-semibold text-[color:var(--color-warning,#d97706)]">Approaching a margin call</p>
          <p className="mt-0.5 text-sm text-foreground">Your equity is within {(warningBufferPct * 100).toFixed(0)}% of the {maintenancePct * 100}% maintenance requirement. If it drops further, positions may be sold automatically. Consider repaying some of your loan or adding cash now.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <ShieldCheck className="h-5 w-5 shrink-0 text-[color:var(--color-gain)]" />
      <p className="text-sm text-foreground">Your margin account is in good standing — equity is comfortably above the maintenance requirement.</p>
    </div>
  );
}

function Num({ label, hint, value, sub, tone }: { label: string; hint?: string; value: string; sub?: string; tone?: "gain" | "loss" }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular", tone === "gain" && "text-[color:var(--color-gain)]", tone === "loss" && "text-[color:var(--color-loss)]")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const EVENT_META: Record<MarginEventKind, { label: string; icon: typeof Landmark; cls: string }> = {
  enabled: { label: "Margin enabled", icon: ShieldCheck, cls: "bg-[color:var(--color-primary)]/15 text-[color:var(--color-primary)]" },
  disabled: { label: "Margin disabled", icon: ShieldOff, cls: "bg-muted text-muted-foreground" },
  borrow: { label: "Borrowed", icon: ArrowDownToLine, cls: "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]" },
  repay: { label: "Repaid", icon: ArrowUpFromLine, cls: "bg-[color:var(--color-gain)]/15 text-[color:var(--color-gain)]" },
  interest: { label: "Interest charged", icon: Percent, cls: "bg-muted text-muted-foreground" },
  warning: { label: "Warning", icon: AlertTriangle, cls: "bg-[color:var(--color-warning,#b45309)]/15 text-[color:var(--color-warning,#d97706)]" },
  call: { label: "Margin call", icon: Siren, cls: "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]" },
  liquidation: { label: "Positions sold to cover the call", icon: Scissors, cls: "bg-[color:var(--color-loss)]/15 text-[color:var(--color-loss)]" },
};

type SoldItem = { kind: "stock" | "option"; symbol: string; quantity?: number; contracts?: number; price?: number; premium?: number; proceeds: number };

function eventDescription(event: MarginEvent): string {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const amount = Number(event.amount);
  switch (event.kind) {
    case "enabled":
    case "disabled":
      return "";
    case "borrow":
      if (typeof detail.symbol === "string") return `To buy ${fmtQty(Number(detail.quantity ?? 0))} ${detail.symbol} @ ${fmtUSD(Number(detail.price ?? 0))}`;
      if (typeof detail.contract_id === "string") return `To buy ${Number(detail.contracts ?? 0)} contract(s) of ${detail.contract_id}`;
      return "";
    case "repay":
      if (detail.manual) return "Manual repayment";
      if (typeof detail.symbol === "string") return `From selling ${fmtQty(Number(detail.quantity ?? 0))} ${detail.symbol} @ ${fmtUSD(Number(detail.price ?? 0))}`;
      if (typeof detail.contract_id === "string" && detail.source === "settlement") return `From ${detail.contract_id} settling`;
      if (typeof detail.contract_id === "string") return `From selling ${Number(detail.contracts ?? 0)} contract(s) of ${detail.contract_id}`;
      return "";
    case "interest":
      return `${(Number(detail.rate ?? 0) * 100).toFixed(0)}% annual rate`;
    case "warning":
    case "call":
      return `Equity ${fmtUSD(Number(detail.equity ?? amount))} vs. requirement ${fmtUSD(Number(detail.maintenanceRequirement ?? 0))}`;
    case "liquidation": {
      const sold = Array.isArray(detail.sold) ? (detail.sold as SoldItem[]) : [];
      if (sold.length === 0) return `Total proceeds ${fmtUSD(amount)}`;
      return sold
        .map((item) =>
          item.kind === "stock"
            ? `Sold ${fmtQty(item.quantity ?? 0)} ${item.symbol} for ${fmtUSD(item.proceeds)}`
            : `Sold ${item.contracts ?? 0} contract(s) of ${item.symbol} for ${fmtUSD(item.proceeds)}`,
        )
        .join(" · ");
    }
    default:
      return "";
  }
}

function EventRow({ event }: { event: MarginEvent }) {
  const meta = EVENT_META[event.kind];
  const Icon = meta.icon;
  const amount = Number(event.amount);
  const showAmount = amount !== 0 && event.kind !== "warning" && event.kind !== "call";
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider", meta.cls)}>
          <Icon className="h-3 w-3" /> {meta.label}
        </span>
        {showAmount && <span className="text-sm font-semibold tabular">{fmtUSD(amount)}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground tabular">{new Date(event.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      </div>
      {eventDescription(event) && <p className="mt-1.5 text-sm text-foreground/90">{eventDescription(event)}</p>}
    </div>
  );
}
