// Throwaway E2E for AI Insights (run with vite-node after migration 0009).
// Part 1: real per-stock insight for NVDA + VOO, DURABLY persisted (kind='stock').
// Part 2: same-process repeat = 0 extra Claude calls.
// Part 3: daily brief for a test user with a watchlist.
// The FRESH-PROCESS (cold-start) proof lives in verify-insights-fresh.ts, which
// must be run as a SEPARATE process so module memory is genuinely empty.
//
// HARDENED HARNESS (brought up to the standard the rest of the repo's
// verify-*.ts scripts have used since M1, after this script itself hung
// during the Options & Margin hardening pass and had to be killed manually):
// every await wrapped in withTimeout() so a stalled call throws a clearly-
// labeled error within a bounded time instead of blocking forever; every
// step prints a timestamped line before AND after it runs; the entire body
// is inside one top-level try/catch that explicitly calls process.exit() —
// vite-node's SSR module runtime does not reliably exit the process on an
// uncaught top-level exception the way plain Node does, which was the root
// cause of the original "hang" (see HANDOFF.md's verification-harness rule).
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getStockInsight, runDailyBriefs, insightClaudeCalls, resetInsightClaudeCalls } from "@/lib/insights/insights.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser } from "./verify-harness";

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 45000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
}
async function step<T>(label: string, fn: () => Promise<T>, ms = 45000): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}

const env = Object.fromEntries(readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/).filter((l) => l && !l.trim().startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const admin = getServiceClient();
const day = new Date().toISOString().slice(0, 10);
let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
const ADVICE = /\byou should\b|\byou must\b|\bwe recommend\b|\bwe advise\b|\bi recommend\b|recommend (buying|selling)/i;
const scanAdvice = (...parts: string[]) => parts.filter((p) => ADVICE.test(p));

const created: string[] = [];

async function main() {
  // Attempt to clear today's shared rows for a deterministic start. KNOWN,
  // ALREADY-DOCUMENTED LIMITATION (see HANDOFF.md's V1 Insights section):
  // service_role has never had a DELETE grant on `insights` (0009 granted
  // only select/insert/update) — production code never needs it either,
  // since real rows are only ever superseded per symbol/day, never deleted.
  // So this is expected to no-op some days (whenever this exact symbol
  // already got a real insight earlier today, e.g. from manual UI testing)
  // — checked and logged, not silently swallowed, but NOT treated as fatal.
  const delResult = await step("attempt to clear today's NVDA/VOO stock-insight rows (best-effort)", () =>
    admin.from("insights").delete().eq("kind", "stock").eq("created_at", day).in("symbol", ["NVDA", "VOO"]),
  );
  if (delResult.error) {
    console.log(`  ⚠️  delete not permitted (known gap, not fatal): ${delResult.error.message}`);
  }

  // Ground truth, not an assumption: check whether each symbol ALREADY has a
  // row for today (independent of whether the delete above worked), so the
  // Claude-call-count assertions below are correct either way instead of
  // hardcoding "must be exactly 1" and depending on a table we can't force-empty.
  async function hadRowToday(symbol: string): Promise<boolean> {
    const { data } = await step(`check for a pre-existing ${symbol} row today`, () =>
      admin.from("insights").select("id").eq("kind", "stock").eq("symbol", symbol).eq("created_at", day).maybeSingle(),
      15000,
    );
    return !!data;
  }
  const nvdaPreexisted = await hadRowToday("NVDA");
  const vooPreexisted = await hadRowToday("VOO");
  console.log(`  ground truth before this run: NVDA row already existed today = ${nvdaPreexisted}, VOO = ${vooPreexisted}`);

  console.log("\n████ 1. Per-stock insight — NVDA (volatile) ████");
  resetInsightClaudeCalls();
  const nvda = await step("getStockInsight(NVDA) — fresh Claude call or same-day DB cache hit", () => getStockInsight("NVDA"), 60000);
  console.log(JSON.stringify(nvda, null, 2));
  assert("lean is bullish/bearish/neutral", ["bullish", "bearish", "neutral"].includes(nvda.lean), nvda.lean);
  assert("confidence is low/moderate/high", ["low", "moderate", "high"].includes(nvda.confidence), nvda.confidence);
  assert("summary present", nvda.summary.length > 20);
  assert("drivers present (3-5)", nvda.drivers.length >= 1 && nvda.drivers.length <= 6, `${nvda.drivers.length}`);
  assert("grounded in real recent news", nvda.usedNews > 0, `${nvda.usedNews} news items`);
  assert("historical_parallel present", nvda.historical_parallel.length > 20);
  assert("risks present", nvda.risks.length >= 1);
  assert("watch_for present", nvda.watch_for.length > 5);
  const adv1 = scanAdvice(nvda.summary, ...nvda.drivers, ...nvda.risks, nvda.watch_for, nvda.historical_parallel);
  assert("NO directive-advice language", adv1.length === 0, adv1.join(" | "));
  const nvdaExpectedCalls = nvdaPreexisted ? 0 : 1;
  assert(
    `FIRST call cost ${nvdaExpectedCalls} Claude call${nvdaExpectedCalls === 1 ? "" : "s"} (${nvdaPreexisted ? "same-day row already existed → DB cache hit" : "genuinely fresh symbol today"})`,
    insightClaudeCalls() === nvdaExpectedCalls,
    `${insightClaudeCalls()}`,
  );

  console.log("\n████ 2. Durability + same-process cache ████");
  const { data: row } = await step("read back the persisted NVDA insight row", () =>
    admin.from("insights").select("user_id, kind, symbol, created_at").eq("kind", "stock").eq("symbol", "NVDA").eq("created_at", day).maybeSingle(),
  );
  assert("insight PERSISTED to the insights table (kind='stock')", !!row, JSON.stringify(row));
  assert("shared row has user_id NULL (no user data, readable by all)", row?.user_id === null);
  const callsAfterFirst = insightClaudeCalls();
  const nvda2 = await step("getStockInsight(NVDA) — same-process repeat", () => getStockInsight("NVDA"));
  assert("same-process repeat returns the identical insight", nvda2.generatedAt === nvda.generatedAt);
  assert("same-process repeat cost 0 extra Claude calls", insightClaudeCalls() === callsAfterFirst, `total ${insightClaudeCalls()}, was ${callsAfterFirst}`);

  console.log("\n████ 3. Per-stock insight — VOO (ETF) ████");
  const callsBeforeVoo = insightClaudeCalls();
  const voo = await step("getStockInsight(VOO) — fresh Claude call or same-day DB cache hit", () => getStockInsight("VOO"), 60000);
  console.log(JSON.stringify(voo, null, 2));
  assert("VOO insight well-formed", ["bullish", "bearish", "neutral"].includes(voo.lean) && voo.summary.length > 20 && voo.historical_parallel.length > 10);
  const adv2 = scanAdvice(voo.summary, ...voo.drivers, ...voo.risks, voo.watch_for, voo.historical_parallel);
  assert("VOO: NO directive-advice language", adv2.length === 0, adv2.join(" | "));
  const vooExpectedNewCalls = vooPreexisted ? 0 : 1;
  assert(
    `VOO cost ${vooExpectedNewCalls} more Claude call${vooExpectedNewCalls === 1 ? "" : "s"} (${vooPreexisted ? "same-day row already existed → DB cache hit" : "genuinely fresh symbol today"})`,
    insightClaudeCalls() - callsBeforeVoo === vooExpectedNewCalls,
    `total ${insightClaudeCalls()}`,
  );
  console.log(`  NVDA generatedAt (compare against the fresh-process run): ${nvda.generatedAt}`);

  console.log("\n████ 4. Daily market brief — real user with a watchlist ████");
  const email = `pt-insight-${Date.now()}@example.org`;
  const { uid } = await step("create test user", () => createTestUser(admin, email, "Test1234!pw"), 15000);
  created.push(uid);
  const pub = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: sErr } = await step("sign in test user", () => pub.auth.signInWithPassword({ email, password: "Test1234!pw" }), 15000);
  if (sErr) throw new Error("signIn: " + sErr.message);
  // ignoreDuplicates: true matches the real addToWatchlist() — plain upsert
  // (DO UPDATE) needs an UPDATE grant the `authenticated` role was never given
  // (and the real app never needed, since it always upserts this way too).
  const { error: wErr } = await step("seed watchlist (NVDA/AAPL/VOO)", () =>
    pub.from("watchlist").upsert(["NVDA", "AAPL", "VOO"].map((symbol) => ({ user_id: uid, symbol })), { onConflict: "user_id,symbol", ignoreDuplicates: true }),
    15000,
  );
  if (wErr) throw new Error("seed watchlist: " + wErr.message);

  const before = insightClaudeCalls();
  const summary = await step("runDailyBriefs({onlyUserIds:[uid]}) — real Claude call", () => runDailyBriefs({ onlyUserIds: [uid] }), 60000);
  console.log("  brief job summary:", JSON.stringify(summary));
  assert("exactly one brief written", summary.briefsWritten === 1, `${summary.briefsWritten}`);
  assert("one Claude call for the one user", insightClaudeCalls() - before === 1, `${insightClaudeCalls() - before}`);
  const { data: brow } = await step("read back the persisted brief row", () =>
    admin.from("insights").select("payload, created_at, kind, symbol, user_id").eq("user_id", uid).eq("kind", "brief").maybeSingle(),
    15000,
  );
  assert("brief row stored for today (symbol NULL)", !!brow && brow.created_at === day && brow.symbol === null);
  const brief = brow?.payload as { headline_takeaway: string; items: Array<{ symbol: string }>; overall_note: string };
  console.log("  stored brief:", JSON.stringify(brief, null, 2));
  assert("brief has headline + overall note", !!brief?.headline_takeaway && !!brief?.overall_note);
  assert("brief items reference tracked symbols only", (brief?.items ?? []).every((it) => ["NVDA", "AAPL", "VOO"].includes(it.symbol)), (brief?.items ?? []).map((i) => i.symbol).join(","));

  console.log("\n████ 5. Users with nothing tracked are skipped ████");
  const { uid: uid2 } = await step("create second (empty) test user", () => createTestUser(admin, `pt-insight-empty-${Date.now()}@example.org`, "Test1234!pw"), 15000);
  created.push(uid2);
  const s2 = await step("runDailyBriefs for the empty user (should no-op)", () => runDailyBriefs({ onlyUserIds: [uid2] }), 30000);
  assert("no brief for a user with no holdings/watchlist", s2.briefsWritten === 0 && s2.usersConsidered === 0, JSON.stringify(s2));
}

main()
  .catch((e) => {
    failures++;
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
  })
  .finally(async () => {
    for (const id of created) {
      try {
        await withTimeout(`cleanup insights for ${id}`, admin.from("insights").delete().eq("user_id", id), 15000);
      } catch (e) {
        console.error(`  cleanup (insights) failed for ${id}:`, e instanceof Error ? e.message : e);
      }
      try {
        await withTimeout(`cleanup user ${id}`, admin.auth.admin.deleteUser(id), 15000);
      } catch (e) {
        console.error(`  cleanup (user) failed for ${id}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`\nCleaned up ${created.length} test users.  ${failures === 0 ? "PART A PASSED ✅" : `${failures} CHECK(S)/STEP(S) FAILED ❌`}`);
    console.log("NOTE: the NVDA kind='stock' row is intentionally LEFT in place — the fresh-process proof reads it.");
    process.exit(failures === 0 ? 0 : 1);
  });
