// FRESH-PROCESS (serverless cold-start) proof for AI Insights.
// Run this as a SEPARATE process AFTER verify-insights.ts: a new node process has
// genuinely empty module memory, exactly like a cold Vercel invocation. Today's
// NVDA insight must come from the insights TABLE with ZERO Claude calls.
import { getStockInsight, insightClaudeCalls, resetInsightClaudeCalls } from "@/lib/insights/insights.server";

resetInsightClaudeCalls();
const t0 = Date.now();
const insight = await getStockInsight("NVDA");
const calls = insightClaudeCalls();

console.log("FRESH PROCESS (empty module memory — simulates a cold serverless invocation)");
console.log(`  symbol           : ${insight.symbol}`);
console.log(`  lean/confidence  : ${insight.lean} / ${insight.confidence}`);
console.log(`  generatedAt      : ${insight.generatedAt}   <-- must MATCH the first run (came from the DB, not regenerated)`);
console.log(`  elapsed          : ${Date.now() - t0}ms`);
console.log(`  CLAUDE CALLS     : ${calls}`);
console.log(calls === 0 ? "\nFRESH-PROCESS PROOF PASSED ✅ — 0 Claude calls, served durably from the insights table." : `\nFAILED ❌ — ${calls} Claude call(s) in a cold process (would leak paid calls in prod).`);
process.exit(calls === 0 ? 0 : 1);
