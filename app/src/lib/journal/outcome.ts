// Pure computation: "what actually happened since this note was written."
// This is the payoff of the journal — pairing a stated reason with a
// measured result — so it's kept as a pure function of already-fetched data
// (no extra network round trip beyond what the pages already query) and
// unit-testable in isolation, mirroring lib/margin/borrowSplit.ts's split
// between pure math and I/O.
//
// SCOPE NOTE: this app has no lot tracking (avg-cost weighted, not FIFO
// lots), so "closed" outcomes use the most recent closing transaction for
// that symbol/contract as the exit reference, not a precise 1:1 match to
// THIS specific buy if the position was closed, reopened, and closed again
// since. Labeled as "closed — last exit at $X", never overclaimed as an
// exact realized P&L for this one trade.

import type { JournalEntry, Transaction, OptionTransaction } from "@/lib/supabase/types";
import type { EnrichedOptionPosition } from "@/lib/options/valuation.server";
import { quoteOf } from "@/lib/marketData/useQuotes";
import type { Quote } from "@/lib/marketData/types";

export type JournalOutcome =
  | { kind: "none" }
  | {
      kind: "stock";
      side: "buy" | "sell";
      status: "open" | "closed" | "unknown";
      entryPrice: number;
      comparePrice: number | null;
      changePct: number | null;
      asOf: string | null; // date of the exit transaction, when status === "closed"
    }
  | {
      kind: "option";
      side: "buy_to_open" | "sell_to_close";
      status: "open" | "closed" | "expired" | "unknown";
      entryPremium: number;
      comparePremium: number | null;
      changePct: number | null;
      asOf: string | null;
    };

export type JournalOutcomeContext = {
  transactions: Transaction[];
  optionTransactions: OptionTransaction[];
  heldSymbols: Set<string>; // symbols with a current holdings row
  openContractIds: Set<string>; // contract_ids with a current option_positions row
  optionPositions: EnrichedOptionPosition[]; // for currentPremium on open contracts
  stockQuotes: Map<string, Quote> | undefined;
};

function pct(from: number, to: number): number | null {
  if (!(from > 0)) return null;
  return (to - from) / from;
}

export function computeJournalOutcome(entry: JournalEntry, ctx: JournalOutcomeContext): JournalOutcome {
  if (entry.transaction_id) {
    const tx = ctx.transactions.find((t) => t.id === entry.transaction_id);
    if (!tx) return { kind: "none" };

    if (tx.side === "sell") {
      // Already realized at tx.price — the only useful forward-looking signal
      // is "did the stock keep moving after you sold," shown as informational,
      // not as this trade's own P&L.
      const current = quoteOf(ctx.stockQuotes, tx.symbol).price;
      return {
        kind: "stock",
        side: "sell",
        status: "open",
        entryPrice: tx.price,
        comparePrice: current || null,
        changePct: current ? pct(tx.price, current) : null,
        asOf: null,
      };
    }

    // buy
    if (ctx.heldSymbols.has(tx.symbol)) {
      const current = quoteOf(ctx.stockQuotes, tx.symbol).price;
      return {
        kind: "stock",
        side: "buy",
        status: "open",
        entryPrice: tx.price,
        comparePrice: current || null,
        changePct: current ? pct(tx.price, current) : null,
        asOf: null,
      };
    }

    // Not currently held — closed. Invariant: if no holdings row exists for
    // this symbol, the most recent transaction for it must be a 'sell' (the
    // trade engine deletes the holdings row exactly when a sell zeros it).
    const lastForSymbol = ctx.transactions
      .filter((t) => t.symbol === tx.symbol)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (lastForSymbol && lastForSymbol.side === "sell") {
      return {
        kind: "stock",
        side: "buy",
        status: "closed",
        entryPrice: tx.price,
        comparePrice: lastForSymbol.price,
        changePct: pct(tx.price, lastForSymbol.price),
        asOf: lastForSymbol.created_at,
      };
    }
    return { kind: "stock", side: "buy", status: "unknown", entryPrice: tx.price, comparePrice: null, changePct: null, asOf: null };
  }

  if (entry.option_transaction_id) {
    const otx = ctx.optionTransactions.find((t) => t.id === entry.option_transaction_id);
    if (!otx) return { kind: "none" };

    if (otx.side === "sell_to_close") {
      return {
        kind: "option",
        side: "sell_to_close",
        status: "closed",
        entryPremium: otx.premium,
        comparePremium: null,
        changePct: null,
        asOf: null,
      };
    }

    // buy_to_open
    if (ctx.openContractIds.has(otx.contract_id)) {
      const pos = ctx.optionPositions.find((p) => p.contractId === otx.contract_id);
      const current = pos?.currentPremium ?? null;
      return {
        kind: "option",
        side: "buy_to_open",
        status: "open",
        entryPremium: otx.premium,
        comparePremium: current,
        changePct: current != null ? pct(otx.premium, current) : null,
        asOf: null,
      };
    }

    const lastForContract = ctx.optionTransactions
      .filter((t) => t.contract_id === otx.contract_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (lastForContract && lastForContract.side !== "buy_to_open") {
      return {
        kind: "option",
        side: "buy_to_open",
        status: lastForContract.side === "expired" ? "expired" : "closed",
        entryPremium: otx.premium,
        comparePremium: lastForContract.premium,
        changePct: pct(otx.premium, lastForContract.premium),
        asOf: lastForContract.created_at,
      };
    }
    return { kind: "option", side: "buy_to_open", status: "unknown", entryPremium: otx.premium, comparePremium: null, changePct: null, asOf: null };
  }

  return { kind: "none" };
}
