// Real E2E for PLAN.md §6 step 6 (B1 — trade journal), run with vite-node.
// REAL Supabase (RLS-scoped anon clients + service_role admin client), REAL
// live market price, REAL execute_trade/execute_option_trade RPCs (the
// exact functions 0023_journal.sql extended to also return the new
// transaction id) — no mocks. Throwaway users, deleted at the end.
//
// Calls execute_trade/execute_option_trade DIRECTLY via admin.rpc(), same
// as every other trade-engine verify script in this repo — this script is
// about proving the JOURNAL's linkage/outcome logic, not re-deriving option
// pricing (already covered by verify-options-trade-live.ts), so option
// premiums here are simple fixed numbers, not Black-Scholes output.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { getServerQuote } from "@/lib/marketData/quote.server";
import { computeJournalOutcome } from "@/lib/journal/outcome";
import type { Transaction, OptionTransaction, JournalEntry } from "@/lib/supabase/types";

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms))]);
}
async function step<T>(label: string, fn: () => Promise<T>, ms = 20000): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}
let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function money(n: number) {
  return `$${Number(n).toFixed(6)}`;
}
function closeTo(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const admin = getServiceClient();
const anonUrl = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;
const PASSWORD = "JournalVerifyTest!234";
const created: string[] = [];

async function main() {
  console.log("\n████ Setup: two throwaway users (A = primary, B = RLS isolation check) ████");
  const stamp = Date.now();
  const emailA = `pt-journal-a-${stamp}@example.org`;
  const emailB = `pt-journal-b-${stamp}@example.org`;
  const userA = await step("create user A", () =>
    admin.auth.admin.createUser({ email: emailA, password: PASSWORD, email_confirm: true, user_metadata: { terms_accepted_version: "test-harness" } }),
  );
  const userB = await step("create user B", () =>
    admin.auth.admin.createUser({ email: emailB, password: PASSWORD, email_confirm: true, user_metadata: { terms_accepted_version: "test-harness" } }),
  );
  if (userA.error || !userA.data.user || userB.error || !userB.data.user) throw new Error("user creation failed");
  const uidA = userA.data.user.id;
  const uidB = userB.data.user.id;
  created.push(uidA, uidB);
  console.log(`  user A: ${emailA} (${uidA})`);
  console.log(`  user B: ${emailB} (${uidB})`);

  const clientA = createClient(anonUrl, anonKey, { auth: { persistSession: false } });
  const clientB = createClient(anonUrl, anonKey, { auth: { persistSession: false } });
  const signInA = await step("sign in as A", () => clientA.auth.signInWithPassword({ email: emailA, password: PASSWORD }));
  const signInB = await step("sign in as B", () => clientB.auth.signInWithPassword({ email: emailB, password: PASSWORD }));
  if (signInA.error || signInB.error) throw new Error("sign-in failed");

  console.log("\n████ 1. STOCK BUY, trade-time note, outcome OPEN (position still held) ████");
  const nvdaQuote = await step("real live NVDA quote", () => getServerQuote("NVDA"));
  const buyPrice = nvdaQuote.price;
  const buyRpc = await step("execute_trade: buy 2 NVDA (the REAL 0023-extended RPC)", () =>
    admin.rpc("execute_trade", { p_user_id: uidA, p_symbol: "NVDA", p_side: "buy", p_quantity: 2, p_price: buyPrice }),
  );
  if (buyRpc.error) throw new Error("buy failed: " + buyRpc.error.message);
  const buyResult = buyRpc.data as Record<string, unknown>;
  const buyTxnId = String(buyResult.transaction_id);
  assert("execute_trade returned a real transaction_id (the 0023 change)", !!buyTxnId && buyTxnId !== "undefined" && buyTxnId !== "null");

  const buyTxnRow = await step("confirm transaction_id matches a REAL transactions row", () =>
    admin.from("transactions").select("*").eq("id", buyTxnId).single(),
  );
  assert("returned transaction_id resolves to a real row", !buyTxnRow.error && buyTxnRow.data?.symbol === "NVDA" && Number(buyTxnRow.data?.price) === buyPrice);

  const noteA = await step("create trade-linked journal entry as user A (via anon/RLS client)", () =>
    clientA.from("journal_entries").insert({ user_id: uidA, transaction_id: buyTxnId, symbol: "NVDA", title: "AI momentum", body: "Buying because AI momentum still building." }).select("*").single(),
  );
  if (noteA.error) throw new Error("create note failed: " + noteA.error.message);
  const noteAId = noteA.data.id as string;
  assert("note created, symbol denormalized from the trade", noteA.data.symbol === "NVDA");

  const freshQuote = await step("fresh live NVDA quote for outcome comparison", () => getServerQuote("NVDA"));
  const txnsA = (await admin.from("transactions").select("*").eq("user_id", uidA)).data as Transaction[];
  const openOutcome = computeJournalOutcome(noteA.data as JournalEntry, {
    transactions: txnsA,
    optionTransactions: [],
    heldSymbols: new Set(["NVDA"]),
    openContractIds: new Set(),
    optionPositions: [],
    stockQuotes: new Map([["NVDA", freshQuote]]),
  });
  console.log(`  outcome: ${JSON.stringify(openOutcome)}`);
  assert("outcome kind=stock, side=buy, status=open", openOutcome.kind === "stock" && openOutcome.side === "buy" && openOutcome.status === "open");
  if (openOutcome.kind === "stock") {
    assert("entryPrice reconciles EXACTLY to the transaction's own price", closeTo(openOutcome.entryPrice, buyPrice));
    assert("comparePrice reconciles EXACTLY to the fresh live quote", closeTo(openOutcome.comparePrice ?? NaN, freshQuote.price));
    const expectedPct = (freshQuote.price - buyPrice) / buyPrice;
    assert("changePct computed correctly to the cent", closeTo(openOutcome.changePct ?? NaN, expectedPct, 1e-9), `got ${openOutcome.changePct} expected ${expectedPct}`);
  }

  console.log("\n████ 2. THE KEY PROPERTY: note survives its position being FULLY CLOSED ████");
  const msftQuote = await step("real live MSFT quote", () => getServerQuote("MSFT"));
  const buyPrice2 = msftQuote.price;
  const buyRpc2 = await step("execute_trade: buy 1 MSFT", () =>
    admin.rpc("execute_trade", { p_user_id: uidA, p_symbol: "MSFT", p_side: "buy", p_quantity: 1, p_price: buyPrice2 }),
  );
  if (buyRpc2.error) throw new Error("buy2 failed: " + buyRpc2.error.message);
  const buyTxnId2 = String((buyRpc2.data as Record<string, unknown>).transaction_id);

  const noteMsft = await step("create trade-linked note on the MSFT buy", () =>
    clientA.from("journal_entries").insert({ user_id: uidA, transaction_id: buyTxnId2, symbol: "MSFT", body: "Testing a full round-trip close." }).select("*").single(),
  );
  if (noteMsft.error) throw new Error("create MSFT note failed: " + noteMsft.error.message);

  const sellPrice = buyPrice2 * 1.0123; // deliberately different from buy price, deterministic
  const sellRpc = await step("execute_trade: SELL ALL 1 MSFT — this deletes the holdings row", () =>
    admin.rpc("execute_trade", { p_user_id: uidA, p_symbol: "MSFT", p_side: "sell", p_quantity: 1, p_price: sellPrice }),
  );
  if (sellRpc.error) throw new Error("sell failed: " + sellRpc.error.message);
  const sellTxnId = String((sellRpc.data as Record<string, unknown>).transaction_id);

  const holdingAfterClose = await step("confirm the holdings row is GONE (position fully closed)", () =>
    admin.from("holdings").select("*").eq("user_id", uidA).eq("symbol", "MSFT").maybeSingle(),
  );
  assert("holdings row deleted after full sell (the ephemeral half of the design)", !holdingAfterClose.data);

  // Read via A's own authenticated session, not admin — journal_entries
  // deliberately has NO service_role grant (0023's own comment explains
  // why: it's the most personal data in the product, and withholding the
  // grant means even our own server tooling structurally cannot read it).
  // This is also more faithful verification: it proves what the app itself
  // can actually see, the same path real users go through.
  const noteStillExists = await step("confirm the journal entry ITSELF still exists in the DB (via A's own session)", () =>
    clientA.from("journal_entries").select("*").eq("id", noteMsft.data.id).single(),
  );
  assert("journal entry survives — NOT deleted when the holding was (the permanent-ledger design)", !noteStillExists.error && !!noteStillExists.data, noteStillExists.error?.message ?? "");
  if (!noteStillExists.data) throw new Error(`cannot continue §2 without the surviving row: ${noteStillExists.error?.message}`);
  assert("surviving entry's transaction_id is unchanged/still resolvable", noteStillExists.data.transaction_id === buyTxnId2);

  const txnsAfterClose = (await admin.from("transactions").select("*").eq("user_id", uidA)).data as Transaction[];
  const closedOutcome = computeJournalOutcome(noteStillExists.data as JournalEntry, {
    transactions: txnsAfterClose,
    optionTransactions: [],
    heldSymbols: new Set(["NVDA"]), // MSFT deliberately NOT in this set — it's closed
    openContractIds: new Set(),
    optionPositions: [],
    stockQuotes: new Map(),
  });
  console.log(`  outcome after close: ${JSON.stringify(closedOutcome)}`);
  assert("outcome correctly reads status=closed now that the holding is gone", closedOutcome.kind === "stock" && closedOutcome.status === "closed");
  if (closedOutcome.kind === "stock" && closedOutcome.status === "closed") {
    assert("closed comparePrice = the EXACT sell price that closed it", closeTo(closedOutcome.comparePrice ?? NaN, sellPrice));
    const expectedPct2 = (sellPrice - buyPrice2) / buyPrice2;
    assert("closed changePct reconciles to the cent", closeTo(closedOutcome.changePct ?? NaN, expectedPct2, 1e-9));
    assert("asOf = the closing sell transaction's own timestamp", !!closedOutcome.asOf);
  }
  void sellTxnId;

  console.log("\n████ 3. OPTION BUY-TO-OPEN → note → CLOSE (sell_to_close), outcome pairing ████");
  const expiry = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const contractId = `NVDA-${expiry}-C-500`;
  const buyOptPremium = 3.5;
  const buyOptRpc = await step("execute_option_trade: buy_to_open 1 contract (the REAL 0023-extended RPC)", () =>
    admin.rpc("execute_option_trade", {
      p_user_id: uidA,
      p_contract_id: contractId,
      p_symbol: "NVDA",
      p_opt_type: "call",
      p_strike: 500,
      p_expiry: expiry,
      p_side: "buy_to_open",
      p_contracts: 1,
      p_premium: buyOptPremium,
    }),
  );
  if (buyOptRpc.error) throw new Error("option buy failed: " + buyOptRpc.error.message);
  const optTxnId = String((buyOptRpc.data as Record<string, unknown>).option_transaction_id);
  assert("execute_option_trade returned a real option_transaction_id (the 0023 change)", !!optTxnId && optTxnId !== "undefined");

  const optTxnRow = await step("confirm option_transaction_id resolves to a real row", () => admin.from("option_transactions").select("*").eq("id", optTxnId).single());
  assert("returned option_transaction_id resolves correctly", !optTxnRow.error && optTxnRow.data?.contract_id === contractId);

  const noteOpt = await step("create trade-linked note on the option buy", () =>
    clientA.from("journal_entries").insert({ user_id: uidA, option_transaction_id: optTxnId, symbol: "NVDA", body: "Speculative call, testing option outcome pairing." }).select("*").single(),
  );
  if (noteOpt.error) throw new Error("create option note failed: " + noteOpt.error.message);

  const sellOptPremium = 5.25;
  const sellOptRpc = await step("execute_option_trade: sell_to_close (closes the option position)", () =>
    admin.rpc("execute_option_trade", {
      p_user_id: uidA,
      p_contract_id: contractId,
      p_symbol: "NVDA",
      p_opt_type: "call",
      p_strike: 500,
      p_expiry: expiry,
      p_side: "sell_to_close",
      p_contracts: 1,
      p_premium: sellOptPremium,
    }),
  );
  if (sellOptRpc.error) throw new Error("option sell failed: " + sellOptRpc.error.message);

  const optPosAfter = await step("confirm option_positions row is gone (closed)", () => admin.from("option_positions").select("*").eq("user_id", uidA).eq("contract_id", contractId).maybeSingle());
  assert("option_positions row deleted after full close", !optPosAfter.data);

  const optTxnsA = (await admin.from("option_transactions").select("*").eq("user_id", uidA)).data as OptionTransaction[];
  const optOutcome = computeJournalOutcome(noteOpt.data as JournalEntry, {
    transactions: [],
    optionTransactions: optTxnsA,
    heldSymbols: new Set(),
    openContractIds: new Set(), // closed now
    optionPositions: [],
    stockQuotes: new Map(),
  });
  console.log(`  option outcome: ${JSON.stringify(optOutcome)}`);
  assert("option outcome kind=option, side=buy_to_open, status=closed", optOutcome.kind === "option" && optOutcome.side === "buy_to_open" && optOutcome.status === "closed");
  if (optOutcome.kind === "option") {
    assert("option entryPremium reconciles to the buy premium exactly", closeTo(optOutcome.entryPremium, buyOptPremium));
    assert("option comparePremium reconciles to the sell_to_close premium exactly", closeTo(optOutcome.comparePremium ?? NaN, sellOptPremium));
    const expectedOptPct = (sellOptPremium - buyOptPremium) / buyOptPremium;
    assert("option changePct reconciles to the cent", closeTo(optOutcome.changePct ?? NaN, expectedOptPct, 1e-9));
  }

  console.log("\n████ 4. Standalone entry (no trade link) ████");
  const standalone = await step("create a standalone entry as user A", () =>
    clientA.from("journal_entries").insert({ user_id: uidA, symbol: "TSLA", body: "Just watching TSLA, no trade yet." }).select("*").single(),
  );
  if (standalone.error) throw new Error("create standalone failed: " + standalone.error.message);
  const standaloneOutcome = computeJournalOutcome(standalone.data as JournalEntry, {
    transactions: [],
    optionTransactions: [],
    heldSymbols: new Set(),
    openContractIds: new Set(),
    optionPositions: [],
    stockQuotes: new Map(),
  });
  assert("standalone entry outcome kind=none", standaloneOutcome.kind === "none");

  console.log("\n████ 5. Edit ████");
  const beforeUpdatedAt = standalone.data.updated_at;
  await new Promise((r) => setTimeout(r, 1100)); // ensure a measurable now() delta
  const edited = await step("edit the standalone entry's body", () =>
    clientA.from("journal_entries").update({ body: "Updated: actually watching TSLA closely now." }).eq("id", standalone.data.id).select("*").single(),
  );
  assert("edit succeeded, body changed", !edited.error && edited.data?.body === "Updated: actually watching TSLA closely now.");
  assert("updated_at trigger fired (changed on edit)", edited.data?.updated_at !== beforeUpdatedAt);

  console.log("\n████ 6. Delete ████");
  const del = await step("delete the standalone entry", () => clientA.from("journal_entries").delete().eq("id", standalone.data.id));
  assert("delete returned no error", !del.error);
  const afterDelete = await step("confirm it's actually gone (via A's own session)", () => clientA.from("journal_entries").select("id").eq("id", standalone.data.id).maybeSingle());
  assert("entry genuinely gone from the DB", !afterDelete.data);

  console.log("\n████ 7. RLS isolation between A and B ████");
  const bReadA = await step("user B tries to SELECT user A's note (should return empty, not an error)", () => clientB.from("journal_entries").select("*").eq("id", noteAId));
  assert("RLS: user B sees ZERO rows of user A's journal", !bReadA.error && (bReadA.data ?? []).length === 0);

  const bUpdateA = await step("user B tries to UPDATE user A's note by id", () => clientB.from("journal_entries").update({ body: "hijacked" }).eq("id", noteAId).select("*"));
  assert("RLS: update affects ZERO rows (not applied)", !bUpdateA.error && (bUpdateA.data ?? []).length === 0);
  const noteAUnchanged = await step("confirm A's note body is untouched (via A's own session)", () => clientA.from("journal_entries").select("body").eq("id", noteAId).single());
  assert("A's note body genuinely unchanged after B's attempted hijack", noteAUnchanged.data?.body === "Buying because AI momentum still building.");

  const bDeleteA = await step("user B tries to DELETE user A's note by id", () => clientB.from("journal_entries").delete().eq("id", noteAId).select("*"));
  assert("RLS: delete affects ZERO rows", !bDeleteA.error && (bDeleteA.data ?? []).length === 0);
  const noteAStillExists = await step("confirm A's note still exists after B's attempted delete (via A's own session)", () => clientA.from("journal_entries").select("id").eq("id", noteAId).maybeSingle());
  assert("A's note survives B's attempted delete", !!noteAStillExists.data);

  console.log("\n████ 8. Constraint checks ████");
  const bothLinks = await step("attempt to insert a note with BOTH transaction_id AND option_transaction_id set", () =>
    clientA.from("journal_entries").insert({ user_id: uidA, transaction_id: buyTxnId, option_transaction_id: optTxnId, symbol: "NVDA", body: "should fail" }),
  );
  assert("DB rejects a dual-linked entry (at-most-one-link CHECK constraint)", !!bothLinks.error);

  const blankBody = await step("attempt to insert a blank-body entry", () => clientA.from("journal_entries").insert({ user_id: uidA, symbol: "NVDA", body: "   " }));
  assert("DB rejects a blank body (not-blank CHECK constraint)", !!blankBody.error);

  console.log("\n████ Cleanup ████");
  for (const uid of created) {
    await admin.auth.admin.deleteUser(uid);
  }
  console.log(`  deleted ${created.length} throwaway users (cascades journal_entries via FK)`);
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
    for (const uid of created) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch {
        /* best effort */
      }
    }
    process.exit(1);
  });
