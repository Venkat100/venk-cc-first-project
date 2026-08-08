// Shared borrow-vs-cash disclosure for buy-side ConfirmDialogs (stock buy,
// option buy-to-open). Pure, client-safe, no server calls. The caller
// supplies cash/loan/rate straight from getMarginState — the M1 source of
// truth — this file only computes the trivial cash-first/borrow-remainder
// split execute_trade and execute_option_trade already use server-side
// (`v_cash_used = least(total, cash); v_borrowed = greatest(0, total-cash)`
// in 0012_margin.sql). It never re-derives buying power, equity, or the
// maintenance requirement — those stay server-only.

import { fmtUSD } from "@/lib/mockData";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type BorrowSplit = {
  /** true only when margin is enabled AND this order would draw on the loan. */
  willBorrow: boolean;
  cashPortion: number;
  borrowedPortion: number;
  loanBefore: number;
  loanAfter: number;
};

export function computeBorrowSplit(estCost: number, cashBalance: number, marginEnabled: boolean, marginLoan: number): BorrowSplit {
  const cashPortion = Math.max(0, Math.min(estCost, cashBalance));
  const borrowedPortion = Math.max(0, round2(estCost - cashPortion));
  const willBorrow = marginEnabled && borrowedPortion > 0.005;
  return {
    willBorrow,
    cashPortion: round2(cashPortion),
    borrowedPortion,
    loanBefore: round2(marginLoan),
    loanAfter: round2(marginLoan + (willBorrow ? borrowedPortion : 0)),
  };
}

/** Appended to a buy ConfirmDialog's consequence line — empty string when
 *  nothing would be borrowed (margin off, or the order is fully cash-covered),
 *  so the dialog reads identically to the pre-margin/no-borrow case. Framed
 *  as an estimate ("about") since the split depends on the cash balance and
 *  price at the moment the dialog opened, not necessarily the instant the
 *  server executes the fill. */
export function borrowSplitSentence(split: BorrowSplit, interestRate?: number): string {
  if (!split.willBorrow) return "";
  const ratePct = interestRate != null ? ` at ${(interestRate * 100).toFixed(0)}%` : "";
  return ` This would draw about ${fmtUSD(split.cashPortion)} from cash and borrow about ${fmtUSD(split.borrowedPortion)} on margin — your loan would go from ${fmtUSD(split.loanBefore)} to about ${fmtUSD(split.loanAfter)}, and interest accrues daily${ratePct}.`;
}
