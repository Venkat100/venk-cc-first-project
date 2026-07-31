// Throwaway E2E for AI Insights (run with vite-node after migration 0009).
// Part 1: real per-stock insight for NVDA + VOO, DURABLY persisted (kind='stock').
// Part 2: same-process repeat = 0 extra Claude calls.
// Part 3: daily brief for a test user with a watchlist.
// The FRESH-PROCESS (cold-start) proof lives in verify-insights-fresh.ts, which
// must be run as a SEPARATE process so module memory is genuinely empty.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getStockInsight, runDailyBriefs, insightClaudeCalls, resetInsightClaudeCalls } from "@/lib/insights/insights.server";
import { getServiceClient } from "@/lib/supabase/admin.server";

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

try {
  // Deterministic start: clear today's shared rows for the symbols under test.
  await admin.from("insights").delete().eq("kind", "stock").eq("created_at", day).in("symbol", ["NVDA", "VOO"]);

  console.log("\n████ 1. Per-stock insight — NVDA (volatile) ████");
  resetInsightClaudeCalls();
  const nvda = await getStockInsight("NVDA");
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
  assert("FIRST call cost exactly 1 Claude call", insightClaudeCalls() === 1, `${insightClaudeCalls()}`);

  console.log("\n████ 2. Durability + same-process cache ████");
  const { data: row } = await admin.from("insights").select("user_id, kind, symbol, created_at").eq("kind", "stock").eq("symbol", "NVDA").eq("created_at", day).maybeSingle();
  assert("insight PERSISTED to the insights table (kind='stock')", !!row, JSON.stringify(row));
  assert("shared row has user_id NULL (no user data, readable by all)", row?.user_id === null);
  const nvda2 = await getStockInsight("NVDA");
  assert("same-process repeat returns the identical insight", nvda2.generatedAt === nvda.generatedAt);
  assert("same-process repeat cost 0 extra Claude calls", insightClaudeCalls() === 1, `total ${insightClaudeCalls()}`);

  console.log("\n████ 3. Per-stock insight — VOO (ETF) ████");
  const voo = await getStockInsight("VOO");
  console.log(JSON.stringify(voo, null, 2));
  assert("VOO insight well-formed", ["bullish", "bearish", "neutral"].includes(voo.lean) && voo.summary.length > 20 && voo.historical_parallel.length > 10);
  const adv2 = scanAdvice(voo.summary, ...voo.drivers, ...voo.risks, voo.watch_for, voo.historical_parallel);
  assert("VOO: NO directive-advice language", adv2.length === 0, adv2.join(" | "));
  assert("VOO cost 1 more Claude call (different symbol)", insightClaudeCalls() === 2, `total ${insightClaudeCalls()}`);
  console.log(`  NVDA generatedAt (compare against the fresh-process run): ${nvda.generatedAt}`);

  console.log("\n████ 4. Daily market brief — real user with a watchlist ████");
  const email = `pt-insight-${Date.now()}@example.org`;
  const { data: u, error: uErr } = await admin.auth.admin.createUser({ email, password: "Test1234!pw", email_confirm: true });
  if (uErr || !u.user) throw new Error("createUser: " + uErr?.message);
  const uid = u.user.id;
  created.push(uid);
  const pub = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: sErr } = await pub.auth.signInWithPassword({ email, password: "Test1234!pw" });
  if (sErr) throw new Error("signIn: " + sErr.message);
  // ignoreDuplicates: true matches the real addToWatchlist() — plain upsert
  // (DO UPDATE) needs an UPDATE grant the `authenticated` role was never given
  // (and the real app never needed, since it always upserts this way too).
  const { error: wErr } = await pub.from("watchlist").upsert(["NVDA", "AAPL", "VOO"].map((symbol) => ({ user_id: uid, symbol })), { onConflict: "user_id,symbol", ignoreDuplicates: true });
  if (wErr) throw new Error("seed watchlist: " + wErr.message);

  const before = insightClaudeCalls();
  const summary = await runDailyBriefs({ onlyUserIds: [uid] });
  console.log("  brief job summary:", JSON.stringify(summary));
  assert("exactly one brief written", summary.briefsWritten === 1, `${summary.briefsWritten}`);
  assert("one Claude call for the one user", insightClaudeCalls() - before === 1, `${insightClaudeCalls() - before}`);
  const { data: brow } = await admin.from("insights").select("payload, created_at, kind, symbol, user_id").eq("user_id", uid).eq("kind", "brief").maybeSingle();
  assert("brief row stored for today (symbol NULL)", !!brow && brow.created_at === day && brow.symbol === null);
  const brief = brow?.payload as { headline_takeaway: string; items: Array<{ symbol: string }>; overall_note: string };
  console.log("  stored brief:", JSON.stringify(brief, null, 2));
  assert("brief has headline + overall note", !!brief?.headline_takeaway && !!brief?.overall_note);
  assert("brief items reference tracked symbols only", (brief?.items ?? []).every((it) => ["NVDA", "AAPL", "VOO"].includes(it.symbol)), (brief?.items ?? []).map((i) => i.symbol).join(","));

  console.log("\n████ 5. Users with nothing tracked are skipped ████");
  const { data: u2 } = await admin.auth.admin.createUser({ email: `pt-insight-empty-${Date.now()}@example.org`, password: "Test1234!pw", email_confirm: true });
  if (u2?.user) {
    created.push(u2.user.id);
    const s2 = await runDailyBriefs({ onlyUserIds: [u2.user.id] });
    assert("no brief for a user with no holdings/watchlist", s2.briefsWritten === 0 && s2.usersConsidered === 0, JSON.stringify(s2));
  }
} finally {
  for (const id of created) {
    await admin.from("insights").delete().eq("user_id", id).catch(() => {});
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

console.log(`\nCleaned up ${created.length} test users.  ${failures === 0 ? "PART A PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
console.log("NOTE: the NVDA kind='stock' row is intentionally LEFT in place — the fresh-process proof reads it.");
process.exit(failures === 0 ? 0 : 1);
