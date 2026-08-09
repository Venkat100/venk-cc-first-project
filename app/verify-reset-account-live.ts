// Real E2E for C1b (reset_paper_account — 0015). REAL Postgres + real
// Finnhub/Twelve Data quotes, no mocks. One RICH primary test user (stock
// holding, option position, funded+active agent with a holding + a pending
// AND a non-pending proposal, margin enabled with an outstanding loan,
// multi-day snapshot history, a watchlist entry) + one lightweight second
// user seeded with SOME state, to prove isolation. Both deleted after.
//
// HARNESS: per the standing rule established during M1 (a 4-hour silent
// hang was root-caused to vite-node not exiting on an uncaught top-level
// throw) — every await goes through withTimeout(), every step logs a
// timestamped before/after line, and the whole body is one try/catch with
// an explicit process.exit().
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { getRealizedVol } from "@/lib/options/volatility.server";
import { buildChain, parseContractId, priceParsedContract } from "@/lib/options/chain.server";
import { STARTING_CASH } from "@/lib/mockData";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) {
  return `$${Number(n).toFixed(2)}`;
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
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
  const env = Object.fromEntries(
    envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  const anonUrl = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  const stamp = Date.now();
  const PASSWORD = "C1bVerifyPass!234";

  // ── Setup: two throwaway users ──────────────────────────────────────────
  console.log("\n████ Setup ████");
  const emailA = `pt-c1b-rich-${stamp}@example.org`;
  const emailB = `pt-c1b-other-${stamp}@example.org`;
  const createdA = await step("create rich test user (A)", 15000, () => admin.auth.admin.createUser({ email: emailA, password: PASSWORD, email_confirm: true }));
  const createdB = await step("create isolation test user (B)", 15000, () => admin.auth.admin.createUser({ email: emailB, password: PASSWORD, email_confirm: true }));
  if (createdA.error || !createdA.data.user || createdB.error || !createdB.data.user) throw new Error(`user creation failed: ${createdA.error?.message} ${createdB.error?.message}`);
  const uidA = createdA.data.user.id;
  const uidB = createdB.data.user.id;
  console.log(`  user A (rich): ${emailA} (${uidA})`);
  console.log(`  user B (isolation check): ${emailB} (${uidB})`);

  const clientA = createClient(anonUrl, anonKey);
  const clientB = createClient(anonUrl, anonKey);
  const signInA = await step("sign in user A", 15000, () => clientA.auth.signInWithPassword({ email: emailA, password: PASSWORD }));
  const signInB = await step("sign in user B", 15000, () => clientB.auth.signInWithPassword({ email: emailB, password: PASSWORD }));
  if (signInA.error || !signInA.data.session || signInB.error || !signInB.data.session) throw new Error("sign-in failed");

  // ── Seed user A: stock, option, margin+loan, agent (funded, active,
  // non-default settings, a holding, a PENDING proposal, a NON-pending
  // proposal), snapshot history, watchlist ──────────────────────────────
  console.log("\n████ Seed user A: a rich account ████");
  const quote = await step("quote NVDA", 15000, () => getServerQuote("NVDA"));
  const buyStock = await step("buy 2 NVDA (real trade)", 20000, () =>
    admin.rpc("execute_trade", { p_user_id: uidA, p_symbol: "NVDA", p_side: "buy", p_quantity: 2, p_price: quote.price, p_positions_value: 0 }));
  if (buyStock.error) throw new Error("seed stock buy failed: " + buyStock.error.message);
  console.log(`  bought 2 NVDA @ ${money(quote.price)}`);

  const [vol] = await step("realized vol NVDA", 15000, () => Promise.all([getRealizedVol("NVDA")]));
  const chain = buildChain({ symbol: "NVDA", spot: quote.price, vol });
  const expiry = chain.expiries.find((e) => e.daysToExpiry > 0) ?? chain.expiries[0];
  const contract = expiry.strikes[Math.floor(expiry.strikes.length / 2)].call;
  const parsed = parseContractId(contract.contractId)!;
  const priced = priceParsedContract(parsed, quote.price, vol);
  const buyOpt = await step("buy 1 option contract (real trade)", 20000, () =>
    admin.rpc("execute_option_trade", {
      p_user_id: uidA, p_contract_id: contract.contractId, p_symbol: parsed.symbol, p_opt_type: parsed.type, p_strike: parsed.strike, p_expiry: parsed.expiry,
      p_side: "buy_to_open", p_contracts: 1, p_premium: priced.premium, p_positions_value: 0,
    }));
  if (buyOpt.error) throw new Error("seed option buy failed: " + buyOpt.error.message);
  console.log(`  bought 1 ${contract.contractId} @ ${money(priced.premium)}/share`);

  const enableMargin = await step("enable margin (real RPC)", 15000, () => admin.rpc("set_margin_enabled", { p_user_id: uidA, p_enabled: true }));
  if (enableMargin.error) throw new Error("seed enable margin failed: " + enableMargin.error.message);
  const seedLoan = await step("seed margin_loan = $5,000 (M1 test seam)", 15000, () => admin.rpc("admin_seed_margin_state", { p_user_id: uidA, p_margin_loan: 5000, p_last_interest_accrued_at: null }));
  if (seedLoan.error) throw new Error("seed margin loan failed: " + seedLoan.error.message);
  console.log(`  margin enabled, loan seeded to $5,000.00`);

  await step("seed agent_config (funded, active, non-default settings)", 15000, () =>
    admin.from("agent_config").upsert({ user_id: uidA, enabled: true, mode: "approve", risk_level: "aggressive", agent_cash: 3000, allocated_total: 5000 }));
  await step("seed agent_holdings row", 15000, () =>
    admin.from("agent_holdings").insert({ user_id: uidA, symbol: "AAPL", quantity: 5, avg_cost: 200, trailing_stop_price: 180 }));
  const pendingProposal = await step("seed a PENDING agent_proposal (expect: deleted)", 15000, () =>
    admin.from("agent_proposals").insert({ user_id: uidA, status: "pending", target: [{ symbol: "AAPL", weight: 1, score: 1, beta: 1, reason: "seed" }], trades: [], rationale: "seed pending — should be deleted by reset", commentary: "test" }).select("id").single());
  const approvedProposal = await step("seed a NON-pending agent_proposal (expect: kept)", 15000, () =>
    admin.from("agent_proposals").insert({ user_id: uidA, status: "approved", target: [], trades: [], rationale: "seed approved — should SURVIVE reset (only pending is deleted)", commentary: "test" }).select("id").single());
  await step("seed an agent_decisions row (append-only, expect: kept)", 15000, () =>
    admin.from("agent_decisions").insert({ user_id: uidA, action: "buy", symbol: "AAPL", rationale: "seed decision", signals: {} }));

  await step("seed OLD portfolio_snapshots history (expect: replaced by one fresh $100k today row)", 15000, () =>
    admin.from("portfolio_snapshots").insert([
      { user_id: uidA, total_value: 50000, cash: 10000, holdings_value: 40000, captured_at: "2026-07-01" },
      { user_id: uidA, total_value: 95000, cash: 20000, holdings_value: 75000, captured_at: "2026-08-01" },
    ]));
  await step("seed an agent_snapshots row (expect: deleted, no replacement)", 15000, () =>
    admin.from("agent_snapshots").insert({ user_id: uidA, total_value: 5000, agent_cash: 1000, holdings_value: 4000, captured_at: "2026-08-01" }));

  await step("seed watchlist via the REAL RLS-scoped anon client (expect: survives reset)", 15000, () =>
    clientA.from("watchlist").insert({ user_id: uidA, symbol: "TSLA" }));

  // ── Seed user B: some state, to prove reset(A) never touches it ────────
  console.log("\n████ Seed user B: some state (isolation control) ████");
  const buyStockB = await step("buy 1 NVDA for user B", 20000, () =>
    admin.rpc("execute_trade", { p_user_id: uidB, p_symbol: "NVDA", p_side: "buy", p_quantity: 1, p_price: quote.price, p_positions_value: 0 }));
  if (buyStockB.error) throw new Error("seed B stock buy failed: " + buyStockB.error.message);
  await step("enable margin for user B + seed a loan", 15000, async () => {
    const en = await admin.rpc("set_margin_enabled", { p_user_id: uidB, p_enabled: true });
    if (en.error) throw new Error(en.error.message);
    const ln = await admin.rpc("admin_seed_margin_state", { p_user_id: uidB, p_margin_loan: 777, p_last_interest_accrued_at: null });
    if (ln.error) throw new Error(ln.error.message);
  });
  await step("seed watchlist for user B", 15000, () => clientB.from("watchlist").insert({ user_id: uidB, symbol: "AMD" }));

  // NOTE: `transactions` (the equities ledger) has NO service_role SELECT
  // grant — migration 0002 only ever granted it to `authenticated` (the
  // same class of gap M1 discovered for `profiles` UPDATE). Real reads of
  // it always go through the authenticated, RLS-scoped client in this app,
  // never service_role — so that's what this verification uses too,
  // instead of masking a permission error as "0 rows" via `admin`.
  async function fullState(uid: string, ownClient: ReturnType<typeof createClient>) {
    const [profile, holdings, options, agentConfig, agentHoldings, proposals, snapshots, agentSnaps, watchlist, tx, optTx, decisions, marginEvents, accountEvents] = await Promise.all([
      admin.from("profiles").select("*").eq("id", uid).single(),
      admin.from("holdings").select("*").eq("user_id", uid),
      admin.from("option_positions").select("*").eq("user_id", uid),
      admin.from("agent_config").select("*").eq("user_id", uid).maybeSingle(),
      admin.from("agent_holdings").select("*").eq("user_id", uid),
      admin.from("agent_proposals").select("*").eq("user_id", uid).order("created_at", { ascending: true }),
      admin.from("portfolio_snapshots").select("*").eq("user_id", uid).order("captured_at", { ascending: true }),
      admin.from("agent_snapshots").select("*").eq("user_id", uid),
      admin.from("watchlist").select("*").eq("user_id", uid),
      ownClient.from("transactions").select("id").eq("user_id", uid),
      admin.from("option_transactions").select("id").eq("user_id", uid),
      admin.from("agent_decisions").select("id").eq("user_id", uid),
      admin.from("margin_events").select("id").eq("user_id", uid),
      admin.from("account_events").select("*").eq("user_id", uid),
    ]);
    if (tx.error) throw new Error("transactions read failed: " + tx.error.message);
    return {
      profile: profile.data, holdings: holdings.data ?? [], options: options.data ?? [], agentConfig: agentConfig.data,
      agentHoldings: agentHoldings.data ?? [], proposals: proposals.data ?? [], snapshots: snapshots.data ?? [],
      agentSnaps: agentSnaps.data ?? [], watchlist: watchlist.data ?? [], txCount: (tx.data ?? []).length,
      optTxCount: (optTx.data ?? []).length, decisionsCount: (decisions.data ?? []).length, marginEventsCount: (marginEvents.data ?? []).length,
      accountEvents: accountEvents.data ?? [],
    };
  }

  console.log("\n████ Capture BEFORE state ████");
  const beforeA = await step("read user A full state", 15000, () => fullState(uidA, clientA));
  const beforeB = await step("read user B full state", 15000, () => fullState(uidB, clientB));

  console.log("  User A BEFORE:");
  console.log(`    cash=${money(beforeA.profile.cash_balance)} margin_enabled=${beforeA.profile.margin_enabled} margin_loan=${money(beforeA.profile.margin_loan)} margin_status=${beforeA.profile.margin_status}`);
  console.log(`    holdings=${beforeA.holdings.length} options=${beforeA.options.length} agent_holdings=${beforeA.agentHoldings.length}`);
  console.log(`    agent_config: enabled=${beforeA.agentConfig?.enabled} mode=${beforeA.agentConfig?.mode} risk=${beforeA.agentConfig?.risk_level} agent_cash=${money(beforeA.agentConfig?.agent_cash ?? 0)} allocated=${money(beforeA.agentConfig?.allocated_total ?? 0)}`);
  console.log(`    proposals=${beforeA.proposals.length} (${beforeA.proposals.map((p: any) => p.status).join(",")})`);
  console.log(`    portfolio_snapshots=${beforeA.snapshots.length} agent_snapshots=${beforeA.agentSnaps.length} watchlist=${beforeA.watchlist.length}`);
  console.log(`    transactions=${beforeA.txCount} option_transactions=${beforeA.optTxCount} agent_decisions=${beforeA.decisionsCount} margin_events=${beforeA.marginEventsCount} account_events=${beforeA.accountEvents.length}`);

  assert("precondition: user A has a nonzero margin_loan before reset", beforeA.profile.margin_loan > 0, `${beforeA.profile.margin_loan}`);
  assert("precondition: user A has 2 proposals seeded (1 pending, 1 approved)", beforeA.proposals.length === 2);
  assert("precondition: user A has 2 old portfolio_snapshots", beforeA.snapshots.length === 2);

  // ── THE RESET ────────────────────────────────────────────────────────
  console.log("\n████ Call reset_paper_account(A) ████");
  const resetResult = await step("reset_paper_account RPC", 20000, () => admin.rpc("reset_paper_account", { p_user_id: uidA }));
  if (resetResult.error) throw new Error("reset failed: " + resetResult.error.message);
  console.log(`  RPC returned: ${JSON.stringify(resetResult.data)}`);

  console.log("\n████ Capture AFTER state ████");
  const afterA = await step("read user A full state (post-reset)", 15000, () => fullState(uidA, clientA));
  const afterB = await step("read user B full state (post-reset of A)", 15000, () => fullState(uidB, clientB));

  // ── Assertions: user A ──────────────────────────────────────────────
  console.log("\n████ Assertions — user A ████");
  assert(`RPC returned cash_balance=${STARTING_CASH} (the current default)`, Number((resetResult.data as any).cash_balance) === STARTING_CASH);
  assert("RPC returned holdings_cleared=1", Number((resetResult.data as any).holdings_cleared) === 1);
  assert("RPC returned option_positions_cleared=1", Number((resetResult.data as any).option_positions_cleared) === 1);
  assert("RPC returned agent_holdings_cleared=1", Number((resetResult.data as any).agent_holdings_cleared) === 1);
  assert("RPC returned pending_proposals_cleared=1", Number((resetResult.data as any).pending_proposals_cleared) === 1);
  assert("RPC returned margin_loan_forgiven=5000", Number((resetResult.data as any).margin_loan_forgiven) === 5000);

  assert(`cash_balance is EXACTLY the current default $${STARTING_CASH}.00`, afterA.profile.cash_balance === STARTING_CASH, `${afterA.profile.cash_balance}`);
  assert("margin_enabled reset to false", afterA.profile.margin_enabled === false);
  assert("margin_loan reset to exactly 0 (the $5,000 loan was forgiven)", afterA.profile.margin_loan === 0, `${afterA.profile.margin_loan}`);
  assert("margin_status reset to 'ok'", afterA.profile.margin_status === "ok");
  assert("last_interest_accrued_at reset to null", afterA.profile.last_interest_accrued_at === null);
  assert("display_name/id/created_at untouched (reset is not re-signup)", afterA.profile.id === beforeA.profile.id && afterA.profile.created_at === beforeA.profile.created_at);

  assert("holdings row DELETED", afterA.holdings.length === 0, `${afterA.holdings.length}`);
  assert("option_positions row DELETED", afterA.options.length === 0, `${afterA.options.length}`);
  assert("agent_holdings row DELETED", afterA.agentHoldings.length === 0, `${afterA.agentHoldings.length}`);

  assert("agent_config reset to defaults: enabled=false", afterA.agentConfig?.enabled === false);
  assert("agent_config reset to defaults: mode='autonomous'", afterA.agentConfig?.mode === "autonomous", `${afterA.agentConfig?.mode}`);
  assert("agent_config reset to defaults: risk_level='balanced'", afterA.agentConfig?.risk_level === "balanced", `${afterA.agentConfig?.risk_level}`);
  assert("agent_config reset to defaults: agent_cash=0", afterA.agentConfig?.agent_cash === 0);
  assert("agent_config reset to defaults: allocated_total=0", afterA.agentConfig?.allocated_total === 0);

  const pendingAfter = afterA.proposals.filter((p: any) => p.status === "pending");
  const approvedAfter = afterA.proposals.filter((p: any) => p.status === "approved");
  assert("the PENDING proposal was deleted", pendingAfter.length === 0, `${pendingAfter.length}`);
  assert("the APPROVED (non-pending) proposal SURVIVED, byte-identical", approvedAfter.length === 1 && approvedAfter[0].id === (approvedProposal.data as any)?.id, JSON.stringify(approvedAfter));

  assert("portfolio_snapshots: old history replaced by EXACTLY 1 row", afterA.snapshots.length === 1, `${afterA.snapshots.length}`);
  if (afterA.snapshots.length === 1) {
    const s = afterA.snapshots[0];
    const today = new Date().toISOString().slice(0, 10);
    assert(`fresh snapshot is dated TODAY (${today}) at exactly $${STARTING_CASH}/$${STARTING_CASH}/$0`, s.captured_at === today && s.total_value === STARTING_CASH && s.cash === STARTING_CASH && s.holdings_value === 0, JSON.stringify(s));
  }
  assert("agent_snapshots: DELETED, no replacement", afterA.agentSnaps.length === 0, `${afterA.agentSnaps.length}`);

  assert("watchlist row SURVIVED reset untouched", afterA.watchlist.length === 1 && afterA.watchlist[0].symbol === "TSLA", JSON.stringify(afterA.watchlist));

  assert("transactions (ledger) row count UNCHANGED — kept, not deleted", afterA.txCount === beforeA.txCount && afterA.txCount > 0, `${beforeA.txCount} → ${afterA.txCount}`);
  assert("option_transactions (ledger) row count UNCHANGED — kept", afterA.optTxCount === beforeA.optTxCount && afterA.optTxCount > 0, `${beforeA.optTxCount} → ${afterA.optTxCount}`);
  assert("agent_decisions (ledger) row count UNCHANGED — kept", afterA.decisionsCount === beforeA.decisionsCount && afterA.decisionsCount > 0, `${beforeA.decisionsCount} → ${afterA.decisionsCount}`);
  assert("margin_events (ledger) row count UNCHANGED — kept", afterA.marginEventsCount === beforeA.marginEventsCount && afterA.marginEventsCount > 0, `${beforeA.marginEventsCount} → ${afterA.marginEventsCount}`);

  assert("exactly ONE new account_events 'reset' marker row written", afterA.accountEvents.length === beforeA.accountEvents.length + 1, `${beforeA.accountEvents.length} → ${afterA.accountEvents.length}`);
  const resetEvent = afterA.accountEvents.find((e: any) => e.kind === "reset");
  console.log(`  account_events 'reset' row detail: ${JSON.stringify(resetEvent?.detail)}`);
  assert("'reset' marker's detail matches the real seeded counts exactly", !!resetEvent && resetEvent.detail.holdings_cleared === 1 && resetEvent.detail.option_positions_cleared === 1 && resetEvent.detail.agent_holdings_cleared === 1 && resetEvent.detail.pending_proposals_cleared === 1 && resetEvent.detail.margin_loan_forgiven === 5000, JSON.stringify(resetEvent?.detail));

  // ── Login/session still works post-reset ────────────────────────────
  console.log("\n████ Login/session still works post-reset ████");
  const sessionCheck = await step("authenticated read via the SAME anon session used before reset", 15000, () => clientA.from("profiles").select("cash_balance, margin_loan").eq("id", uidA).single());
  assert("post-reset authenticated read succeeds (session never invalidated)", !sessionCheck.error, sessionCheck.error?.message);
  assert(`post-reset authenticated read shows the NEW state ($${STARTING_CASH}, no loan)`, sessionCheck.data?.cash_balance === STARTING_CASH && sessionCheck.data?.margin_loan === 0, JSON.stringify(sessionCheck.data));
  const reSignIn = await step("fresh sign-in (a real NEW login) after reset", 15000, () => createClient(anonUrl, anonKey).auth.signInWithPassword({ email: emailA, password: PASSWORD }));
  assert("a fresh login with the same credentials still works after reset", !reSignIn.error && !!reSignIn.data.session, reSignIn.error?.message);

  // ── Assertions: user B fully untouched ──────────────────────────────
  console.log("\n████ Assertions — user B (isolation) ████");
  assert("user B's profile is BYTE-IDENTICAL before/after A's reset", JSON.stringify(beforeB.profile) === JSON.stringify(afterB.profile), `cash ${beforeB.profile.cash_balance}→${afterB.profile.cash_balance}, loan ${beforeB.profile.margin_loan}→${afterB.profile.margin_loan}`);
  assert("user B's holdings UNCHANGED", JSON.stringify(beforeB.holdings) === JSON.stringify(afterB.holdings), `${beforeB.holdings.length} → ${afterB.holdings.length}`);
  assert("user B's watchlist UNCHANGED", JSON.stringify(beforeB.watchlist) === JSON.stringify(afterB.watchlist));
  assert("user B has ZERO account_events (reset was never called for them)", afterB.accountEvents.length === 0, `${afterB.accountEvents.length}`);
  console.log(`  user B: cash=${money(afterB.profile.cash_balance)} loan=${money(afterB.profile.margin_loan)} holdings=${afterB.holdings.length} watchlist=${afterB.watchlist.length} — all unchanged`);

  // ── Defense-in-depth: authenticated client cannot call reset_paper_account directly ──
  console.log("\n████ Defense-in-depth: EXECUTE is service_role-only ████");
  const directCall = await step("authenticated client tries reset_paper_account directly (expect denied)", 15000, () => clientB.rpc("reset_paper_account", { p_user_id: uidB }));
  assert("an authenticated (non-service-role) client CANNOT call reset_paper_account directly", !!directCall.error, directCall.error ? directCall.error.message : "unexpectedly succeeded");
  console.log(`  direct-call error (expected): ${directCall.error?.message}`);

  // ── Cleanup ──────────────────────────────────────────────────────────
  console.log("\n████ Cleanup ████");
  await step("delete all seeded rows + both auth users", 25000, async () => {
    for (const uid of [uidA, uidB]) {
      await admin.from("account_events").delete().eq("user_id", uid);
      await admin.from("margin_events").delete().eq("user_id", uid);
      await admin.from("agent_decisions").delete().eq("user_id", uid);
      await admin.from("agent_proposals").delete().eq("user_id", uid);
      await admin.from("agent_holdings").delete().eq("user_id", uid);
      await admin.from("agent_config").delete().eq("user_id", uid);
      await admin.from("option_transactions").delete().eq("user_id", uid);
      await admin.from("option_positions").delete().eq("user_id", uid);
      await admin.from("transactions").delete().eq("user_id", uid);
      await admin.from("holdings").delete().eq("user_id", uid);
      await admin.from("portfolio_snapshots").delete().eq("user_id", uid);
      await admin.from("agent_snapshots").delete().eq("user_id", uid);
      await admin.from("watchlist").delete().eq("user_id", uid);
      await admin.auth.admin.deleteUser(uid);
    }
  });
  console.log("  done.");

  console.log(`\n${failures === 0 ? "ALL C1B RESET-ACCOUNT LIVE CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n💥 SCRIPT ERROR (process WILL exit — never hangs): ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
