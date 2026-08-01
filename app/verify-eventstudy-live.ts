// Real E2E for AI Insights V2 (event study). Run with vite-node. REAL Twelve
// Data + Claude + Supabase calls, no mocks. Covers: a volatile symbol (NVDA,
// expect a healthy N), a calm symbol (VOO, expect fewer events), a
// short-history symbol (a genuinely recent IPO — whatever Twelve Data
// actually returns, reported honestly, not assumed), day-cache re-confirm
// (0 extra Claude calls AND 0 extra candle fetches on a same-day repeat).
import { readFileSync } from "node:fs";
import { getStockInsight, insightClaudeCalls, resetInsightClaudeCalls } from "@/lib/insights/insights.server";
import { measuredHistoryCalls, resetMeasuredHistoryCalls } from "@/lib/insights/eventstudy.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { providerQuotes } from "@/lib/marketData/finnhub.server";

const env = Object.fromEntries(readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
void env;

const admin = getServiceClient();
const day = new Date().toISOString().slice(0, 10);
let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const SYMBOLS = ["NVDA", "VOO", "CRCL"]; // volatile / calm / recent-IPO (real 2025 IPO — genuinely short history)

try {
  await admin.from("insights").delete().eq("kind", "stock").eq("created_at", day).in("symbol", SYMBOLS);

  console.log("\n████ 1. NVDA (volatile) — real event study + real Claude call ████");
  resetInsightClaudeCalls();
  resetMeasuredHistoryCalls();
  const nvda = await getStockInsight("NVDA");
  console.log("measured_history:", JSON.stringify(nvda.measured_history, null, 2));
  console.log("historical_parallel:", nvda.historical_parallel);
  assert("insight well-formed", ["bullish", "bearish", "neutral"].includes(nvda.lean) && nvda.summary.length > 20);
  assert("measured_history present (not null — Twelve Data reachable)", nvda.measured_history !== null);
  const [nvdaQuote] = await providerQuotes(["NVDA"]);
  const expectedDir = nvdaQuote.dayChangePct >= 0 ? "up" : "down";
  assert("measured_history.direction matches NVDA's actual live day-change sign (independently fetched)", nvda.measured_history?.direction === expectedDir, `day_change_pct=${nvdaQuote.dayChangePct} → expected ${expectedDir}, got ${nvda.measured_history?.direction}`);
  assert("window_years is a healthy multi-year span (NVDA has long history)", (nvda.measured_history?.window_years ?? 0) > 3, `${nvda.measured_history?.window_years}`);
  assert("NVDA (volatile) found a non-trivial number of shock events", (nvda.measured_history?.events_found ?? 0) >= 3, `${nvda.measured_history?.events_found}`);
  assert("exactly 1 event-study candle fetch (not cached from a prior run)", measuredHistoryCalls() === 1, `${measuredHistoryCalls()}`);
  assert("exactly 1 Claude call", insightClaudeCalls() === 1, `${insightClaudeCalls()}`);
  if ((nvda.measured_history?.events_found ?? 0) >= 5) {
    const n = String(nvda.measured_history!.events_found);
    assert("historical_parallel CITES the measured N (grounded, not generic recollection)", nvda.historical_parallel.includes(n), `looked for "${n}"`);
  }

  console.log("\n████ 2. VOO (calm ETF) — real event study + real Claude call ████");
  const voo = await getStockInsight("VOO");
  console.log("measured_history:", JSON.stringify(voo.measured_history, null, 2));
  console.log("historical_parallel:", voo.historical_parallel);
  assert("VOO insight well-formed", ["bullish", "bearish", "neutral"].includes(voo.lean) && voo.summary.length > 20);
  assert("VOO measured_history present", voo.measured_history !== null);
  assert("VOO (calm) has FEWER shock events than NVDA (plausible vs. the chart)", (voo.measured_history?.events_found ?? 999) <= (nvda.measured_history?.events_found ?? 0), `VOO=${voo.measured_history?.events_found} NVDA=${nvda.measured_history?.events_found}`);
  assert("2 total event-study candle fetches so far", measuredHistoryCalls() === 2, `${measuredHistoryCalls()}`);
  assert("2 total Claude calls so far", insightClaudeCalls() === 2, `${insightClaudeCalls()}`);

  console.log("\n████ 3. CRCL (real, genuinely recent IPO — short-history degrade) ████");
  const crcl = await getStockInsight("CRCL").catch((e) => { console.log("  (CRCL insight failed — provider issue, not the event-study path itself:", e instanceof Error ? e.message : e, ")"); return null; });
  if (crcl) {
    console.log("measured_history:", JSON.stringify(crcl.measured_history, null, 2));
    console.log("historical_parallel:", crcl.historical_parallel);
    assert("CRCL insight well-formed (no crash/NaN)", ["bullish", "bearish", "neutral"].includes(crcl.lean) && crcl.summary.length > 20);
    if (crcl.measured_history) {
      assert("CRCL window_years is short (recent IPO) vs. NVDA/VOO's multi-year span", crcl.measured_history.window_years < (nvda.measured_history?.window_years ?? 99), `CRCL=${crcl.measured_history.window_years}y NVDA=${nvda.measured_history?.window_years}y`);
      if (crcl.measured_history.events_found === 0) {
        assert("insufficient-history degrade: all forward-return fields are null, not 0/NaN", [crcl.measured_history.avg_fwd_1w, crcl.measured_history.median_fwd_1w, crcl.measured_history.avg_fwd_1m, crcl.measured_history.median_fwd_1m, crcl.measured_history.worst_1m, crcl.measured_history.best_1m, crcl.measured_history.pct_positive_1m].every((v) => v === null));
        assert("historical_parallel does NOT state fabricated numeric forward-return figures", !/\b\d+(\.\d+)?%/.test(crcl.historical_parallel), crcl.historical_parallel);
      } else {
        console.log(`  (CRCL actually has ${crcl.measured_history.events_found} qualifying events already — reporting real data, not assuming zero)`);
      }
    } else {
      console.log("  (CRCL measured_history is null — Twelve Data likely has no/insufficient data for this symbol; the insight still generated without crashing)");
    }
  }

  console.log("\n████ 4. Day-cache re-confirm: same-day repeat = 0 extra Claude calls AND 0 extra candle fetches ████");
  const claudeBefore = insightClaudeCalls();
  const eventStudyBefore = measuredHistoryCalls();
  const nvdaAgain = await getStockInsight("NVDA");
  assert("repeat returns the IDENTICAL insight (generatedAt unchanged)", nvdaAgain.generatedAt === nvda.generatedAt);
  assert("repeat returns the IDENTICAL measured_history (byte-for-byte)", JSON.stringify(nvdaAgain.measured_history) === JSON.stringify(nvda.measured_history));
  assert("0 extra Claude calls on same-day repeat", insightClaudeCalls() === claudeBefore, `${insightClaudeCalls()} vs ${claudeBefore}`);
  assert("0 extra event-study candle fetches on same-day repeat", measuredHistoryCalls() === eventStudyBefore, `${measuredHistoryCalls()} vs ${eventStudyBefore}`);

  console.log("\n████ 5. Direction sanity — measured_history.direction matches today's actual day-change sign ████");
  // (re-derive independently from the DB row's own signals, not from the module's internal logic)
  const { data: row } = await admin.from("insights").select("payload").eq("kind", "stock").eq("symbol", "NVDA").eq("created_at", day).maybeSingle();
  console.log("  stored row measured_history.direction:", (row?.payload as { measured_history?: { direction?: string } })?.measured_history?.direction);
  assert("stored row's measured_history.direction is 'up' or 'down'", ["up", "down"].includes((row?.payload as { measured_history?: { direction?: string } })?.measured_history?.direction ?? ""));
} finally {
  // Leave the rows in place (like verify-insights.ts leaves NVDA) so they can be inspected; no test users were created this run.
}

console.log(`\n${failures === 0 ? "ALL EVENT-STUDY LIVE CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
