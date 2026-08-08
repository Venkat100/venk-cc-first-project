// Buy-to-open / sell-to-close order flow for a single option contract.
// ONE dialog component handles both directions — opened in "buy" mode from
// the chain (OptionChainView) or "sell" mode from a held position
// (OptionPositionsList) — since the cost-math/stepper/confirm UI is
// otherwise identical. Renders as a bottom sheet on phones and a centered
// dialog on desktop, via Tailwind breakpoints only (one component, no
// separate mobile codebase — same convention as the rest of the app).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { executeOptionTrade } from "@/lib/options/execute";
import { getMarginState } from "@/lib/margin/api";
import { computeBorrowSplit, borrowSplitSentence } from "@/lib/margin/borrowSplit";
import { useAuth } from "@/lib/auth/auth-context";
import { fmtUSD } from "@/lib/mockData";
import type { OptionContract, OptionType, EnrichedOptionPosition } from "@/lib/options/queries";
import { Minus, Plus } from "lucide-react";
import { toast } from "sonner";

export type OrderPanelState =
  | { open: true; mode: "buy"; contract: OptionContract; side: OptionType }
  | { open: true; mode: "sell"; position: EnrichedOptionPosition }
  | { open: false };

// One responsive className: bottom sheet on phones, centered dialog from `sm:` up.
const SHEET_CONTENT_CLASS =
  "inset-x-0 bottom-0 left-0 top-auto max-h-[85vh] w-full max-w-full translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-t-2xl rounded-b-none border-t p-0 sm:inset-auto sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:max-h-[90vh] sm:w-full sm:max-w-md sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border";

export function OptionOrderPanel({ state, onClose }: { state: OrderPanelState; onClose: () => void }) {
  const { profile, refreshProfile } = useAuth();
  // Margin-aware buying power — same gated pattern as the dashboard/stock
  // order panel: only fetches getMarginState() when margin is on.
  const marginStateQ = useQuery({
    queryKey: ["marginState"],
    queryFn: getMarginState,
    enabled: !!profile?.margin_enabled,
    staleTime: 10_000,
  });
  const marginEnabled = !!profile?.margin_enabled;
  const buyingPower = marginEnabled && marginStateQ.data ? marginStateQ.data.buyingPower : (profile?.cash_balance ?? 0);
  // For the buy-to-open ConfirmDialog's borrow-vs-cash disclosure
  // (hardening-pass follow-up) — the same getMarginState() call above
  // already carries cash/loan/rate, so this is free.
  const cashBalance = marginEnabled && marginStateQ.data ? marginStateQ.data.cashBalance : (profile?.cash_balance ?? 0);
  const marginLoan = marginEnabled && marginStateQ.data ? marginStateQ.data.marginLoan : 0;
  const interestRate = marginEnabled ? marginStateQ.data?.interestRate : undefined;
  const qc = useQueryClient();

  const mode = state.open ? state.mode : "buy";
  const symbol = state.open ? (state.mode === "buy" ? state.contract.symbol : state.position.symbol) : "";
  const strike = state.open ? (state.mode === "buy" ? state.contract.strike : state.position.strike) : 0;
  const optType = state.open ? (state.mode === "buy" ? state.side : state.position.optType) : "call";
  const expiry = state.open ? (state.mode === "buy" ? state.contract.expiry : state.position.expiry) : "";
  const premium = state.open ? (state.mode === "buy" ? state.contract.premium : state.position.currentPremium) : 0;
  const contractId = state.open ? (state.mode === "buy" ? state.contract.contractId : state.position.contractId) : "";
  const maxContracts = state.open && state.mode === "sell" ? state.position.contracts : Infinity;

  const [contracts, setContracts] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (state.open) setContracts(1); // reset whenever a new contract/position opens
  }, [state.open, contractId]);

  const cost = premium * 100 * contracts;
  const overBudget = mode === "buy" && cost > buyingPower;
  // Buy-to-open only — sell-to-close never draws on the loan.
  const borrowSplit = computeBorrowSplit(cost, cashBalance, marginEnabled, marginLoan);

  const trade = useMutation({
    mutationFn: () => executeOptionTrade({ contractId, side: mode === "buy" ? "buy_to_open" : "sell_to_close", contracts }),
    onSuccess: async (r) => {
      await Promise.all([
        refreshProfile(),
        qc.invalidateQueries({ queryKey: ["optionPositions"] }),
        qc.invalidateQueries({ queryKey: ["marginState"] }),
      ]);
      const verb = r.side === "buy_to_open" ? "Bought" : "Sold";
      toast.success(`${verb} ${r.contracts} ${symbol} $${strike} ${optType === "call" ? "Call" : "Put"} · ${expiryLabel(expiry)}`, {
        description: `${r.side === "buy_to_open" ? "Cost" : "Proceeds"} ${fmtUSD(r.total)} @ ${fmtUSD(r.premium)}/share · Buying power now ${fmtUSD(r.cashBalance)}`,
      });
      setConfirmOpen(false);
      onClose();
    },
    onError: (e: Error) => {
      toast.error(e.message || "That order couldn't be completed.");
      setConfirmOpen(false);
    },
  });

  const dateLabel = expiry ? expiryLabel(expiry) : "";

  return (
    <Dialog open={state.open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={SHEET_CONTENT_CLASS}>
        <DialogHeader className="border-b border-border px-4 py-3 text-left sm:px-5">
          <DialogTitle className="text-base">{mode === "buy" ? "Buy to open" : "Sell to close"}</DialogTitle>
        </DialogHeader>

        {state.open && (
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="font-semibold">{symbol} ${strike} {optType === "call" ? "Call" : "Put"}</p>
              <p className="text-sm text-muted-foreground">{dateLabel} · {fmtUSD(premium)}/share premium</p>
              {state.open && state.mode === "sell" && (
                <p className="mt-1 text-xs text-muted-foreground">You hold {state.position.contracts} contract{state.position.contracts === 1 ? "" : "s"} · avg premium {fmtUSD(state.position.avgPremium)}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Contracts</p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setContracts((c) => Math.max(1, c - 1))}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent disabled:opacity-40"
                  disabled={contracts <= 1}
                  aria-label="Fewer contracts"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="number"
                  min={1}
                  max={Number.isFinite(maxContracts) ? maxContracts : undefined}
                  step={1}
                  value={contracts}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    if (!Number.isFinite(n)) return;
                    setContracts(Math.max(1, Math.min(Number.isFinite(maxContracts) ? maxContracts : n, n)));
                  }}
                  className="h-11 w-full rounded-md border border-border bg-background text-center text-lg font-semibold tabular"
                />
                <button
                  type="button"
                  onClick={() => setContracts((c) => Math.min(Number.isFinite(maxContracts) ? maxContracts : c + 1, c + 1))}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent disabled:opacity-40"
                  disabled={contracts >= maxContracts}
                  aria-label="More contracts"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {mode === "sell" && (
                <button type="button" onClick={() => setContracts(maxContracts)} className="text-xs text-[color:var(--color-primary)] hover:underline">
                  Sell all {maxContracts}
                </button>
              )}
            </div>

            <div className="rounded-md border border-border bg-surface p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{mode === "buy" ? "Cost" : "Proceeds"} math</span>
                <span className="tabular font-medium">{fmtUSD(premium)} × 100 × {contracts} = {fmtUSD(cost)}</span>
              </div>
              {mode === "buy" && (
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>Buying power</span>
                  <span className={cnOver(overBudget)}>{fmtUSD(buyingPower)}</span>
                </div>
              )}
            </div>

            {overBudget && <p className="text-xs text-[color:var(--color-loss)]">This exceeds your buying power — reduce contracts or add cash.</p>}

            <Button
              disabled={trade.isPending || overBudget || contracts < 1}
              className={
                mode === "buy"
                  ? "h-12 w-full bg-[color:var(--color-gain)] text-base text-[color:var(--color-gain-foreground)] hover:opacity-90"
                  : "h-12 w-full bg-[color:var(--color-loss)] text-base text-[color:var(--color-loss-foreground)] hover:opacity-90"
              }
              onClick={() => setConfirmOpen(true)}
            >
              {trade.isPending ? "Placing…" : mode === "buy" ? `Confirm buy · ${contracts} contract${contracts === 1 ? "" : "s"}` : `Confirm sell · ${contracts} contract${contracts === 1 ? "" : "s"}`}
            </Button>
            <p className="text-[11px] text-muted-foreground">All orders are simulated paper trades. No real money is used. Long options can expire worthless.</p>
          </div>
        )}
      </DialogContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={mode === "buy" ? "Confirm buy to open" : "Confirm sell to close"}
        consequence={
          mode === "buy"
            ? `Buy ${contracts} contract${contracts === 1 ? "" : "s"} of ${symbol} $${strike} ${optType === "call" ? "Call" : "Put"} · ${dateLabel} for about ${fmtUSD(cost)}? This uses ${fmtUSD(cost)} of your ${fmtUSD(buyingPower)} buying power.` +
              borrowSplitSentence(borrowSplit, interestRate)
            : `Sell ${contracts} contract${contracts === 1 ? "" : "s"} of ${symbol} $${strike} ${optType === "call" ? "Call" : "Put"} · ${dateLabel} for an estimated ${fmtUSD(cost)}?`
        }
        detail={
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{mode === "buy" ? "Cost" : "Proceeds"} math</span>
              <span className="tabular font-medium">{fmtUSD(premium)} × 100 × {contracts} = {fmtUSD(cost)}</span>
            </div>
            {mode === "buy" && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Buying power after</span>
                <span className="tabular">{fmtUSD(buyingPower - cost)}</span>
              </div>
            )}
            {mode === "buy" && borrowSplit.willBorrow && (
              <>
                <div className="mt-1.5 flex justify-between border-t border-border pt-1.5 text-xs text-muted-foreground">
                  <span>From cash</span>
                  <span className="tabular">{fmtUSD(borrowSplit.cashPortion)}</span>
                </div>
                <div className="flex justify-between text-xs text-[color:var(--color-loss)]">
                  <span>Borrowed on margin</span>
                  <span className="tabular">{fmtUSD(borrowSplit.borrowedPortion)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Margin loan</span>
                  <span className="tabular">{fmtUSD(borrowSplit.loanBefore)} → {fmtUSD(borrowSplit.loanAfter)}</span>
                </div>
              </>
            )}
          </div>
        }
        confirmLabel={mode === "buy" ? "Confirm buy" : "Confirm sell"}
        loading={trade.isPending}
        onConfirm={() => trade.mutate()}
      />
    </Dialog>
  );
}

function expiryLabel(expiry: string): string {
  return new Date(`${expiry}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function cnOver(over: boolean): string {
  return over ? "tabular text-[color:var(--color-loss)]" : "tabular";
}
