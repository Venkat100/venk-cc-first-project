// What-If Simulator — server function (Phase 7).
//
// PUBLIC: callable WITHOUT authentication. It only reads market data (never
// user data), so logged-out visitors can use it. The provider/API key stay
// server-side (this calls the marketData provider via .server modules).
//
// Math:
//   shares       = amount / price_on_start_date
//   value_today  = shares * latest_price
//   SPY baseline = amount * spy_latest / spy_start  (same window)

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { providerSeries } from "@/lib/marketData/provider.server";
import { cached } from "@/lib/marketData/cache.server";
import { getStock } from "@/lib/mockData";

const SPY = "SPY";
const SERIES_TTL = 30 * 60_000; // 30 min — historical series barely changes intraday

export type SimPoint = { t: string; invest: number; spy: number };

export type SimResult = {
  symbol: string;
  name: string;
  amount: number;
  requestedDate: string; // what the user asked for (YYYY-MM-DD)
  startDate: string; // actual first trading day used (YYYY-MM-DD)
  earliestAvailable: string | null; // set if we had to snap forward to first available data
  startPrice: number;
  latestPrice: number;
  latestDate: string;
  shares: number;
  valueToday: number;
  returnAbs: number;
  returnPct: number;
  spyStartPrice: number;
  spyValueToday: number;
  spyReturnPct: number;
  beatMarketPct: number; // returnPct - spyReturnPct (positive = beat the market)
  series: SimPoint[];
};

export type SimResponse = { ok: true; result: SimResult } | { ok: false; error: string };

function seriesCached(symbol: string, startDate: string) {
  return cached(`series:${symbol.toUpperCase()}:${startDate}`, SERIES_TTL, () => providerSeries(symbol, startDate));
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

// Keep the chart light: stride down to ~maxPoints, always keeping first & last.
function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const stride = Math.ceil(arr.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

export const runSimulationFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      symbol: z.string().min(1).max(12),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date"),
      amount: z.number().positive().max(1_000_000_000),
    }),
  )
  .handler(async ({ data }): Promise<SimResponse> => {
    const symbol = data.symbol.toUpperCase().trim();
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (data.date >= today) return { ok: false, error: "Pick a date in the past — the future hasn't happened yet." };

      const stockSeries = await seriesCached(symbol, data.date);
      if (!stockSeries.length) {
        return { ok: false, error: `We couldn't find price history for "${symbol}". Double-check the ticker and try again.` };
      }

      const startCandle = stockSeries[0];
      const startDate = startCandle.t.slice(0, 10);
      const startPrice = startCandle.close;
      if (!(startPrice > 0)) return { ok: false, error: "No valid starting price was available for that date." };

      const latest = stockSeries[stockSeries.length - 1];
      const latestPrice = latest.close;
      const shares = data.amount / startPrice;
      const valueToday = shares * latestPrice;
      const returnAbs = valueToday - data.amount;
      const returnPct = (returnAbs / data.amount) * 100;

      // S&P 500 baseline over the same actual window.
      const spySeries = await seriesCached(SPY, startDate);
      const spyMap = new Map<string, number>();
      let spyStart = 0;
      let spyReturnPct = 0;
      let spyValueToday = 0;
      if (spySeries.length) {
        spyStart = spySeries[0].close;
        const spyLatest = spySeries[spySeries.length - 1].close;
        if (spyStart > 0) {
          spyReturnPct = (spyLatest / spyStart - 1) * 100;
          spyValueToday = (data.amount * spyLatest) / spyStart;
        }
        for (const c of spySeries) spyMap.set(c.t.slice(0, 10), c.close);
      }

      // Aligned value series (both lines start at `amount`).
      let lastSpy = spyStart;
      const fullPts: SimPoint[] = stockSeries.map((c) => {
        const d = c.t.slice(0, 10);
        const sp = spyMap.get(d);
        if (sp != null) lastSpy = sp;
        return {
          t: c.t,
          invest: +((data.amount * c.close) / startPrice).toFixed(2),
          spy: spyStart > 0 ? +((data.amount * lastSpy) / spyStart).toFixed(2) : 0,
        };
      });
      const series = downsample(fullPts, 160);
      if (series.length) series[series.length - 1] = fullPts[fullPts.length - 1];

      const snapped = daysBetween(data.date, startDate) > 7;

      return {
        ok: true,
        result: {
          symbol,
          name: getStock(symbol)?.name ?? symbol,
          amount: data.amount,
          requestedDate: data.date,
          startDate,
          earliestAvailable: snapped ? startDate : null,
          startPrice,
          latestPrice,
          latestDate: latest.t.slice(0, 10),
          shares,
          valueToday,
          returnAbs,
          returnPct,
          spyStartPrice: spyStart,
          spyValueToday,
          spyReturnPct,
          beatMarketPct: returnPct - spyReturnPct,
          series,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      if (/run out of api credits|rate|limit|429/i.test(msg)) {
        return { ok: false, error: "The market data provider is busy right now (rate limit). Please try again in a minute." };
      }
      if (/not found|no data|invalid symbol|symbol .*not/i.test(msg)) {
        return { ok: false, error: `We couldn't find price history for "${symbol}". Double-check the ticker and try again.` };
      }
      return { ok: false, error: "Something went wrong running that simulation. Please try again." };
    }
  });
