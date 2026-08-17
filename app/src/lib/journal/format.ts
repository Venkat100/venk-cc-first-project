// Presentation-only helpers for showing trade context inline with a
// journal entry. Deliberately does NOT import lib/options/chain.server.ts
// (server-only) — this is a lightweight, display-only re-parse of the same
// stable contractId format, with no security implications (unlike the
// server's re-parse-and-reprice usage, which exists so a client can never
// tamper with strike/expiry/type).

import { fmtUSD, fmtQty } from "@/lib/mockData";
import { formatInstantDate } from "@/lib/format/datetime";
import type { Transaction, OptionTransaction } from "@/lib/supabase/types";

const CONTRACT_ID_RE = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})-([CP])-(\d+(?:\.\d+)?)$/;

function formatDate(iso: string) {
  return formatInstantDate(iso, { month: "short", day: "numeric" });
}

export function stockTradeSummary(tx: Transaction): string {
  const verb = tx.side === "buy" ? "Buy" : "Sell";
  return `${verb} ${fmtQty(tx.quantity)} ${tx.symbol} @ ${fmtUSD(tx.price)} · ${formatDate(tx.created_at)}`;
}

export function optionTradeSummary(otx: OptionTransaction): string {
  const m = CONTRACT_ID_RE.exec(otx.contract_id);
  const contractLabel = m ? `$${m[4]}${m[3]} exp ${m[2]}` : otx.contract_id;
  const verb = otx.side === "buy_to_open" ? "Buy to open" : otx.side === "sell_to_close" ? "Sell to close" : otx.side === "expired" ? "Expired" : "Settled";
  return `${verb} ${fmtQty(otx.contracts, 0)} ${otx.symbol} ${contractLabel} @ ${fmtUSD(otx.premium)} · ${formatDate(otx.created_at)}`;
}
