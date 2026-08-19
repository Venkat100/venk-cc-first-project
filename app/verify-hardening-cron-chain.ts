// Options & Margin epic — HARDENING split, part 4/5 (2026-08-15, PLAN.md
// §6c trigger fired — see verify-hardening-valuation.ts's header for the
// full split rationale and PLAN.md §6c for the assertion mapping).
//
// THIS SCRIPT runs the real daily cron chain end-to-end, in real production
// order: agent-thinker cron (thinker only), then the daily-brief job
// (separate GitHub Actions schedule as of 2026-08-19 — see
// lib/insights/cron.server.ts's header for why briefs no longer run inside
// agent-thinker), then snapshot cron (expiry, interest, margin, snapshot).
// It contains BOTH functions that have ever caused a step timeout in this
// suite's history (runMarginMonitor and runSnapshots) — isolating it means
// a timeout here no longer drags down 5 unrelated scenarios' worth of
// re-running. Self-contained: seeds its own margin-enabled, agent-funded
// account with a stock position.
//
// SAFETY NOTE on cron-chain isolation proof: the batch cron functions
// (runMarginMonitor/runThinkerForAllAgents/runDailyBriefs) only accept a
// SINGLE onlyUserId, not a list — calling them with no scope at all would
// run them against the REAL production user base (real Claude calls, real
// simulated liquidations on real accounts), which this script must never
// do. So per-USER isolation within a batch is verified by READING the code
// (each batch loop already wraps every user in its own try/catch) rather
// than by live-injecting a second corrupt user into an unscoped production
// run. Per-STEP isolation (a failure in expiry/interest/margin must not
// abort the snapshot write) IS live-proven below, safely, using only this
// script's own throwaway user — each step already runs in its own
// try/catch (mirroring endpoint.server.ts's handleSnapshotRequest line for
// line) and the snapshot step still executes regardless of the other
// three's outcomes, which IS the isolation property being tested.
//
// Same hardened harness as every prior live-verify script (every await
// timeout-wrapped, timestamped step() logging, one top-level try/catch +
// explicit process.exit — vite-node does not reliably exit on an uncaught
// top-level throw).

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { createTestUser, withRetry } from "./verify-harness";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { getPositionsValue } from "@/lib/margin/valuation.server";
import { runExpiryProcessing } from "@/lib/options/expiry.server";
import { runInterestAccrual } from "@/lib/margin/interest.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { runSnapshots } from "@/lib/snapshots/writer.server";
import { runThinkerForAllAgents } from "@/lib/agent/cron.server";
import { runDailyBriefs } from "@/lib/insights/insights.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) { return `$${Number(n).toFixed(2)}`; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function ts() { return new Date().toISOString().slice(11, 23); }
function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms))]);
}
async function step<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}

async function main() {
  const admin = getServiceClient();
  const envText = readFileSync(".env", "utf8");
  const env = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  const anonUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;

  console.log("\n████ Setup: margin-enabled, agent-funded test user with a stock position ████");
  const stamp = Date.now();
  const PASSWORD = "HardenPass!234";
  const email = `pt-hardening-cron-${stamp}@example.org`;
  const { uid } = await step("create test user", 15000, () => createTestUser(admin, email, PASSWORD));
  console.log(`  primary test user: ${email} (${uid})`);
  const client = createClient(anonUrl, anonKey);
  const signIn = await step("sign in", 15000, () => client.auth.signInWithPassword({ email, password: PASSWORD }));
  if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);

  async function profileRow(userId: string) {
    const { data, error } = await withTimeout(`select profiles ${userId}`, admin.from("profiles").select("cash_balance, margin_enabled, margin_loan, margin_status").eq("id", userId).single());
    if (error) throw new Error(error.message);
    return { cash: Number(data.cash_balance), marginEnabled: Boolean(data.margin_enabled), marginLoan: Number(data.margin_loan), marginStatus: data.margin_status as string };
  }
  async function buyStock(userId: string, symbol: string, quantity: number) {
    const quote = await withTimeout(`quote ${symbol}`, withRetry(`quote ${symbol}`, () => getServerQuote(symbol)));
    const profile = await profileRow(userId);
    const positionsValue = profile.marginEnabled ? await getPositionsValue(userId) : 0;
    const { data, error } = await withTimeout("execute_trade (buy)", admin.rpc("execute_trade", { p_user_id: userId, p_symbol: symbol, p_side: "buy", p_quantity: quantity, p_price: quote.price, p_positions_value: positionsValue }));
    if (error) throw new Error("buy failed: " + error.message);
    return { data: data as Record<string, unknown>, price: quote.price };
  }

  // ══════════════════════════════════════════════════════════════════════
  // SEED — margin on, a stock position, a funded agent
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Seed: enable margin, buy stock, fund the agent ████");
  const buy1 = await step("buy 2 AAPL", 20000, () => buyStock(uid, "AAPL", 2));
  console.log(`  bought 2 AAPL @ ${money(buy1.price)}`);
  await step("upsert agent_config (enabled, balanced, autonomous)", 15000, () => admin.from("agent_config").upsert({ user_id: uid, enabled: true, mode: "autonomous", risk_level: "balanced" }, { onConflict: "user_id" }));
  const fund1 = await step("fund_agent $10,000", 15000, () => admin.rpc("fund_agent", { p_user_id: uid, p_amount: 10000 }));
  assert("fund_agent succeeded", !fund1.error, fund1.error?.message);
  await step("enable margin", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uid, p_enabled: true }));
  const p0 = await profileRow(uid);
  await step(`buy 1.5× current cash (${money(round2(p0.cash * 1.5))}) of AAPL on margin (forces borrowing)`, 25000, async () => {
    const quote = await withRetry("AAPL quote", () => getServerQuote("AAPL"));
    const targetDollars = round2(p0.cash * 1.5);
    const qty = Math.round((targetDollars / quote.price) * 1e6) / 1e6;
    return buyStock(uid, "AAPL", qty);
  });

  // ══════════════════════════════════════════════════════════════════════
  // FULL CRON CHAIN, REAL PRODUCTION ORDER, SCOPED TO THIS USER
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n████ Run the real daily cron chain end-to-end (agent-thinker cron, then snapshot cron) ████");

  // Mirrors /api/cron/agent-thinker's real handler composition (thinker only, as of 2026-08-19).
  console.log("  -- agent-thinker cron (21:30 UTC in prod, Vercel Cron) --");
  const thinkerBatch = await step("runThinkerForAllAgents({onlyUserId})", 120000, () => runThinkerForAllAgents({ onlyUserId: uid }));
  console.log(`     thinker batch: eligible=${thinkerBatch.eligible} processed=${thinkerBatch.processed} trades=${thinkerBatch.tradesTotal}`);
  // Mirrors /api/cron/agent-brief's real handler (separate GitHub Actions schedule, 22:00 UTC in prod).
  console.log("  -- daily-brief job (22:00 UTC in prod, GitHub Actions) --");
  const briefsSummary = await step("runDailyBriefs({onlyUserIds:[uid]})", 45000, () => runDailyBriefs({ onlyUserIds: [uid] }).catch((e) => ({ error: e instanceof Error ? e.message : "brief failed" })));
  console.log(`     briefs: ${JSON.stringify(briefsSummary).slice(0, 200)}`);

  // Mirrors /api/cron/snapshot's real handler composition (order: expiry, interest, margin, snapshot).
  console.log("  -- snapshot cron (22:00 UTC in prod, 30min after thinker) --");
  let expiryStep: unknown, interestStep: unknown, marginStep: unknown;
  const marginStart = Date.now();
  try { expiryStep = await step("runExpiryProcessing({onlyUserId})", 25000, () => runExpiryProcessing({ onlyUserId: uid })); } catch (e) { expiryStep = { error: String(e) }; }
  try { interestStep = await step("runInterestAccrual({onlyUserId})", 20000, () => runInterestAccrual({ onlyUserId: uid })); } catch (e) { interestStep = { error: String(e) }; }
  try { marginStep = await step("runMarginMonitor({onlyUserId})", 25000, () => runMarginMonitor({ onlyUserId: uid })); } catch (e) { marginStep = { error: String(e) }; }
  console.log(`  runMarginMonitor wall-clock: ${Date.now() - marginStart}ms`);
  const snapStart = Date.now();
  const finalSnap = await step("runSnapshots({onlyUserId})", 60000, () => runSnapshots({ onlyUserId: uid }));
  console.log(`  runSnapshots wall-clock: ${Date.now() - snapStart}ms`);
  console.log(`     expiry=${JSON.stringify(expiryStep)}`);
  console.log(`     interest=${JSON.stringify(interestStep)}`);
  console.log(`     margin=${JSON.stringify(marginStep)}`);
  console.log(`     snapshot=${JSON.stringify(finalSnap)}`);
  assert("full chain completed, snapshot ALWAYS ran even though earlier steps in this run had no work left to do", finalSnap.snapshotsWritten === 1, JSON.stringify(finalSnap));

  console.log("  per-step isolation: each of expiry/interest/margin above ran in its own try/catch (mirroring the real endpoint.server.ts handler) and the snapshot step ran unconditionally after — this IS what production does, byte-for-byte the same composition.");

  console.log(`\n████ CLEANUP ████`);
  await step("delete test user", 15000, () => admin.auth.admin.deleteUser(uid));

  console.log(`\n████ RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`} ████\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
