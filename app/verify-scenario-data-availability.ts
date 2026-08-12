// One-off (kept as a verify-*.ts for the regression suite) check: does
// Twelve Data's free tier actually have daily history reaching back to each
// candidate scenario's start date, for each candidate symbol? Real API
// calls, no mocks — this determines the final scenario/symbol catalog, per
// the kickoff's explicit instruction not to ship a scenario whose data
// isn't actually there.

import { providerSeries } from "@/lib/marketData/provider.server";
import { step, assert, sleep, runVerification } from "./verify-harness";

const CANDIDATES: { scenario: string; startDate: string; endDate: string; symbols: string[] }[] = [
  { scenario: "2020 covid", startDate: "2020-01-02", endDate: "2020-08-31", symbols: ["SPY", "ZM", "CCL", "DAL", "AMZN", "TSLA", "XOM"] },
  { scenario: "2022 bear", startDate: "2022-01-03", endDate: "2022-12-30", symbols: ["SPY", "NFLX", "META", "TSLA", "XOM", "AAPL", "WMT"] },
];

async function main() {
  for (const { scenario, startDate, endDate, symbols } of CANDIDATES) {
    console.log(`\n████ ${scenario} — requested start ${startDate} ████`);
    for (const symbol of symbols) {
      await sleep(8000); // pace under the free tier's ~8 credits/min budget
      try {
        const series = await step(`fetch ${symbol} series since ${startDate}`, () => providerSeries(symbol, startDate, endDate), 20000);
        if (series.length === 0) {
          assert(`${symbol}: has data at all`, false, "EMPTY series");
          continue;
        }
        const actualFirst = series[0].t.slice(0, 10);
        const actualLast = series[series.length - 1].t.slice(0, 10);
        const requested = new Date(startDate).getTime();
        const actual = new Date(actualFirst).getTime();
        const gapDays = Math.round((actual - requested) / 86_400_000);
        assert(`${symbol}: history reaches back to the requested start (small weekend/holiday gap ok)`, gapDays <= 10, `first=${actualFirst} last=${actualLast} n=${series.length} gap=${gapDays}d`);
      } catch (e) {
        // A single symbol's fetch failing (timeout/429/network) shouldn't
        // abort checking the rest — record it as a failed assertion and move on.
        assert(`${symbol}: fetch succeeded`, false, e instanceof Error ? e.message : String(e));
      }
    }
  }
}

runVerification(main, { globalTimeoutMs: 5 * 60_000 });
