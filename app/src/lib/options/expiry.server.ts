// Expiration processing (O4, server-only) — CASH SETTLEMENT of every option
// position whose expiry has passed. v1 does not deliver/exercise shares: an
// in-the-money position settles for its intrinsic value in cash; an
// out-of-the-money position expires worthless. Disclosed in the UI (see
// OptionsExplainer).
//
// EXPIRY BOUNDARY: expiry < today (strictly less than), matching
// execute_option_trade's own "expired" definition in 0010 exactly — a
// contract expiring TODAY is still tradeable through the whole day and is
// settled by TOMORROW's run once it's unambiguously in the past. The two
// functions can never disagree about a contract's status. `settle_expired_
// option` (0011) enforces this same boundary as its own guard, so this
// processor's selection query and the DB's rejection are structurally
// consistent — a bug in one can't silently touch a live position.
//
// SETTLEMENT PRICE: the underlying's daily CLOSE on the expiry date, from
// the same historical candle series already used elsewhere (getDailyHistory,
// shared/cached with the event study + realized-vol estimator). If that
// exact date's candle isn't available (a provider gap, or the calendar date
// landed on something the series doesn't have a bar for), falls back to the
// LATEST available close — documented, not silent: a position must not get
// stuck unsettled forever for want of one candle, and any real stock's price
// rarely moves enough between adjacent trading days for this fallback to
// meaningfully change an ITM/OTM outcome.

import { getServiceClient } from "@/lib/supabase/admin.server";
import { getDailyHistory } from "@/lib/marketData/dailyHistory.server";
import type { OptionType } from "./blackscholes";

const round2 = (n: number) => Math.round(n * 100) / 100;

type PositionRow = {
  id: string;
  user_id: string;
  contract_id: string;
  symbol: string;
  opt_type: OptionType;
  strike: number;
  expiry: string; // YYYY-MM-DD
  contracts: number;
};

export type ExpirySettlement = {
  userId: string;
  contractId: string;
  symbol: string;
  optType: OptionType;
  strike: number;
  expiry: string;
  contracts: number;
  closeUsed: number;
  closeDateUsed: string; // the candle date actually used (may differ from expiry on fallback)
  usedFallbackClose: boolean;
  settlePerShare: number;
  total: number;
  outcome: "settled" | "expired";
};

export type ExpiryProcessingSummary = {
  date: string;
  positionsFound: number;
  settled: number; // ITM, credited > 0
  expiredWorthless: number; // OTM, credited 0
  totalCashCredited: number;
  settlements: ExpirySettlement[];
  errors: string[];
};

/** Close price to use for settling a contract expiring on `expiry`: the exact
 *  date's candle if we have one, else the latest available close (documented
 *  fallback — see file header). Returns null only if the series is empty. */
function closeForExpiry(candles: { t: string; close: number }[], expiry: string): { close: number; dateUsed: string; usedFallback: boolean } | null {
  const exact = candles.find((c) => c.t.slice(0, 10) === expiry);
  if (exact && exact.close > 0) return { close: exact.close, dateUsed: exact.t.slice(0, 10), usedFallback: false };
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > 0) return { close: candles[i].close, dateUsed: candles[i].t.slice(0, 10), usedFallback: true };
  }
  return null;
}

function settlePerShare(optType: OptionType, close: number, strike: number): number {
  return optType === "call" ? Math.max(0, close - strike) : Math.max(0, strike - close);
}

/** Find + settle every expired option position. `onlyUserId` scopes it to one
 *  account (verification / on-demand); omitted in production so the cron
 *  settles every eligible position. Per-position error isolation — one
 *  failure never aborts the batch. */
export async function runExpiryProcessing(opts: { onlyUserId?: string } = {}): Promise<ExpiryProcessingSummary> {
  const admin = getServiceClient();
  const today = new Date().toISOString().slice(0, 10);
  const errors: string[] = [];

  let q = admin.from("option_positions").select("*").lt("expiry", today);
  if (opts.onlyUserId) q = q.eq("user_id", opts.onlyUserId);
  const { data, error } = await q;
  if (error) throw new Error("read option_positions: " + error.message);
  const rows = (data ?? []) as PositionRow[];

  // One candle-series fetch per distinct underlying, reused across every
  // position/user that holds it — same batching discipline as the writer and
  // the valuation module.
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const seriesBySymbol = new Map<string, { t: string; close: number }[]>();
  for (const sym of symbols) {
    try {
      seriesBySymbol.set(sym, await getDailyHistory(sym));
    } catch (e) {
      errors.push(`${sym}: candle fetch failed — ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  const settlements: ExpirySettlement[] = [];
  let settled = 0;
  let expiredWorthless = 0;
  let totalCashCredited = 0;

  for (const r of rows) {
    try {
      const series = seriesBySymbol.get(r.symbol);
      if (!series) throw new Error(`no candle series available for ${r.symbol}`);
      const picked = closeForExpiry(series, r.expiry);
      if (!picked) throw new Error(`no usable close price found for ${r.symbol}`);

      const perShare = round2(settlePerShare(r.opt_type, picked.close, Number(r.strike)));
      const { data: rpc, error: rpcErr } = await admin.rpc("settle_expired_option", {
        p_user_id: r.user_id,
        p_contract_id: r.contract_id,
        p_settle_per_share: perShare,
      });
      if (rpcErr) throw new Error(rpcErr.message);

      const result = rpc as { total: number; side: "settled" | "expired" };
      if (result.side === "settled") settled++;
      else expiredWorthless++;
      totalCashCredited += Number(result.total);

      settlements.push({
        userId: r.user_id,
        contractId: r.contract_id,
        symbol: r.symbol,
        optType: r.opt_type,
        strike: Number(r.strike),
        expiry: r.expiry,
        contracts: Number(r.contracts),
        closeUsed: picked.close,
        closeDateUsed: picked.dateUsed,
        usedFallbackClose: picked.usedFallback,
        settlePerShare: perShare,
        total: round2(Number(result.total)),
        outcome: result.side,
      });
    } catch (e) {
      errors.push(`${r.user_id}/${r.contract_id}: ${e instanceof Error ? e.message : "settlement failed"}`);
    }
  }

  return {
    date: today,
    positionsFound: rows.length,
    settled,
    expiredWorthless,
    totalCashCredited: round2(totalCashCredited),
    settlements,
    errors,
  };
}
