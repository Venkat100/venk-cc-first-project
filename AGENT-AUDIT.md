# AI Portfolio Agent — Production Audit

**Date:** 2026-08-16 · **Scope:** first inspection of unattended operation since the agent epic (Phase 10) went fully autonomous. **Method:** read-only queries against real production data (Postgres, GitHub Actions run history) plus a full read of the agent's source. No trades, resets, or modifications were made to any real user's agent. Two trivially-safe infrastructure fixes were applied during the audit (see Part 1) — nothing else was changed; every other finding below is reported, not fixed.

**Real users with an agent, at time of audit:** 3 enabled (all `autonomous` mode; no real user currently runs `approve` mode or `conservative` risk — noted throughout where that limits what could be directly observed).

| User (short id) | Risk | Allocated | Agent cash (live) | Holdings (live) | First run | Rebalance runs |
|---|---|---:|---:|---:|---|---:|
| `9181c80a` | aggressive | $5,000 | $1,617.76 | 4 positions, $3,381.05 | 2026-06-22 | 56 |
| `1e0c5ffe` | aggressive | $2,000 | $1,112.36 | 2 positions, $964.71 | 2026-06-27 | 51 |
| `f491a434` | balanced | $1,000 | $1,000.00 | **0 positions** | 2026-07-24 | 26 |

---

## Part 1 — Is it actually running?

**Yes, both loops are running, on schedule, for every real eligible agent.** Evidence, not assumption:

- **Vercel `agent-thinker` cron** (`30 21 * * *`, daily): confirmed via real `agent_decisions` rows, not the heartbeat table (see below). Every one of the 3 real enabled agents has a `rebalance` decision on **every single day** from its first-funded day through today, 133 total runs across the three, landing consistently in the 21:33–22:31 UTC window each day — exactly matching the scheduled 21:30 UTC trigger plus normal execution time. Two isolated extra/early runs exist (2026-08-10 at 18:53 UTC, and a second run for one agent on 2026-08-15) — both look like manual verification triggers against the `CRON_SECRET`-protected endpoint, not a scheduling bug; cadence is otherwise exactly 1/day/agent (56/51/26 runs against 55/50/23 elapsed days respectively).
- **🐛 Found and fixed: `cron_heartbeats` for `agent-thinker` was stale — 5 days old (`last_run_at: 2026-08-10`) — while the job had in fact run correctly every day since.** Root cause: `handleAgentThinkerRequest` (`lib/agent/cron.server.ts`) wrote the heartbeat with `void recordHeartbeat(...)` immediately before `return`ing the HTTP response — a classic serverless fire-and-forget bug. Once the response is sent, Vercel can freeze/tear down the function before an un-awaited promise's network round-trip to Supabase completes, silently dropping the write. This explains why the write "worked" on 08-10 (whichever invocation happened to get lucky with teardown timing) and then silently failed on every subsequent day even though the underlying job kept succeeding. **Fixed during this audit** (trivially safe — a pure observability write, zero trading/money-path impact): changed `void recordHeartbeat(...)` to `await recordHeartbeat(...)` in both `lib/agent/cron.server.ts` and (same exact pattern, same risk) `lib/snapshots/endpoint.server.ts`. The snapshot heartbeat happened to be fresh in this sample, but it was racing the identical bug.
- **GitHub Actions `Agent Watchdog` workflow**: state is `active` (not auto-disabled — GitHub's ~60-day-inactivity auto-disable has not triggered, and won't as long as the schedule keeps firing). Sampled the last 100 runs: **98 success, 2 failure**. Both failures (2026-08-06, 17:05 and 18:45 UTC) were GitHub-side infrastructure hiccups ("the job was not acquired by Runner of type hosted even after multiple attempts") — not an application bug, not a secrets/auth problem, self-resolved (the run 20 minutes later succeeded normally). Schedule (`*/30 13-21 * * 1-5`) is correctly Mon–Fri only, confirmed by the real run history clustering exactly in that window with no weekend runs. **No heartbeat exists for the watchdog job** — this is by the code's own explicit design ("deliberately out of scope for this first cut," `heartbeat.server.ts`), not an oversight, but it means `/api/health` currently cannot attest to watchdog health at all; the only evidence of its operation is GitHub's own run history (external to the app) and the `agent_decisions` rows it writes. See Part 7c.
- **No silent failures found.** Every eligible real agent (enabled, `agent_cash > 0` for thinker; enabled + holds ≥1 position for watchdog) produced the expected decision rows every day. The one agent that "looks" inactive (`f491a434`, 0 holdings) is in fact running its full daily cycle correctly — it's just never able to buy anything, which is a real, different, and more interesting bug (Part 3).

## Part 2 — Decision quality

**Rationales are genuinely grounded, not generic filler.** Sampled dozens of real buy/trim decisions across both real aggressive agents; they cite specific, plausible real signals and news threads: *"Anthropic's surging revenue directly benefits Amazon as a major investor, and institutional buying (Viking Global, Thrive Capital) reinforces bullish conviction"*; *"Blowout Q2 earnings drove a 15.32% single-day gain and near-52-week highs"*; *"AWS cloud dominance keeps it central to the $1.3T CapEx cycle."* Every rationale ties back to a concrete number (beta, `pos52`, momentum, day-change%) or a named catalyst — never a bare "looks good" or templated filler line.

**Risk level is genuinely reflected in what got bought.** Both real aggressive agents concentrate 50–60% of capital in high-beta AI/semiconductor names (AMD, NVDA), explicitly reasoning about beta and momentum; one rationale explicitly justifies *excluding* low-beta ETFs: *"Broad market ETFs (VOO, SPY) were excluded as their low beta and momentum add little alpha potential in an aggressive risk framework."* This is correct, intentional risk-level behavior, not noise.

**Cannot verify:** conservative-risk behavior (ETF-heavy, low-beta) has zero real-production evidence — no real user currently runs a conservative agent. This is an honest gap, not a finding either way; the code path is identical in shape to balanced/aggressive (same `scoreCandidates` weighting formula, different constants) and is covered by the unit/integration tests documented in HANDOFF's Phase 10 hardening notes, but has never been proven against real market conditions for a real user.

### 🔴 Major finding: membership churn is real, and it's happening constantly

HANDOFF.md's own hardening-pass notes flagged this as a known, deliberately deferred gap: *"membership churn — a name oscillating in/out of the target set across runs still causes exit/re-buy (the band addresses WEIGHT noise, not membership noise). Consider a stickiness/hysteresis on set membership if it shows up in practice."* **It is showing up in practice, heavily.**

Quantified from the real transaction ledgers:
- `9181c80a`: **AMZN alone has 20 transactions (12 buys, 8 sells)** out of 71 total lifetime trades — over a quarter of this agent's entire trading activity is one symbol oscillating in and out. AAPL: 15 txns (9/6). GOOGL: 8 txns (4/4).
- `1e0c5ffe`: **AMZN has 14 transactions (7 buys, 7 sells)** out of 30 total — nearly half the account's entire history.
- Re-entry gaps are frequently *very* short: AMZN sold→rebought in 1.00, 1.02, and 1.03 days, repeatedly, for both agents. AAPL: 1.00, 1.00, 1.03 days. This is a stock leaving the target list one day and re-entering within 24–48 hours, over and over.

The existing `COOLDOWN_DAYS = 4` anti-whipsaw protection **does not cover this at all** — by design, cooldown only blocks re-buying a symbol the *watchdog* protective-sold (`action='sell'`); a thinker "no longer in target portfolio" exit (`action='trim'`, `kind='exit'`) carries zero cooldown, so a name can be exited and immediately re-bought the very next run if its quant score ticks back up even slightly. Every single sell in the churn above is a `trim`/`exit`, not a `sell` — meaning the one anti-whipsaw mechanism that exists has never once been the thing preventing this, because it structurally can't apply here.

## Part 3 — Money math and guardrails

**Ledger reconciliation: perfect.** For all 3 real agents, net (buys − sells) quantity per symbol from the full `agent_transactions` ledger matches current `agent_holdings.quantity` exactly, symbol by symbol, zero exceptions. No orphaned positions, no phantom holdings, no drift between the ledger and current state. No negative `agent_cash` anywhere.

**Guardrails, checked against live prices at audit time:**

| Agent | Risk | Holdings count | Guardrail range | Cash buffer | Guardrail min | Max position weight | Cap |
|---|---|---:|---|---:|---:|---:|---:|
| `9181c80a` | aggressive | 4 | 3–5 ✅ | 32.4% | 8% | 22.5% (NVDA) | 35% ✅ |
| `1e0c5ffe` | aggressive | **2** | 3–5 **❌** | 53.6% | 8% | 24.8% (AMD) | 35% ✅ |
| `f491a434` | balanced | **0** | 4–6 **❌** | 100% | 15% | — | — |

No position ever exceeds its cap — that guardrail is solid. Cash buffers are always comfortably above their floor, which sounds safe but is really a symptom worth reading correctly: both aggressive agents are sitting on **far** more idle cash than their risk profile intends (32–54% vs. an 8% floor), and the balanced agent is 100% cash. `1e0c5ffe`'s holdings count is currently below its own floor — almost certainly a transient snapshot of the churn described in Part 2 (it just exited AMZN hours before this audit ran) rather than a persistent bug, but it demonstrates the guardrail *can* be observed in a breached state with nothing anywhere flagging it.

### 🔴 Major finding: a real user's agent has never bought anything, for 3+ weeks, with zero indication anything is wrong

`f491a434` (balanced, $1,000 allocated) has run its full daily thinker cycle **26 times since 2026-07-24 and made exactly zero trades**, every single day logging *"Portfolio within drift bands — no trades needed"* — the identical message a genuinely healthy, fully-invested, at-target agent would show. From the dashboard or decision log, this is indistinguishable from success.

**Root cause, confirmed in code** (`lib/agent/rebalance.ts:133-134`):
```ts
const qty = Math.floor(buyDollars / t.price);
if (qty < 1) continue;   // silently skipped — no log entry, no warning
```
The agent buys **whole shares only** — unlike the main manual-trading engine, which explicitly supports fractional/dollar-based investing (per `CLAUDE.md`/`ARCHITECTURE.md`). With $1,000 total capital, balanced guardrails (`cashBuffer: 0.15`, `minHoldings: 4`, `maxHoldings: 6`) leave ~$850 investable, targeted across 4–6 positions ≈ **$141–212 per position**. Every symbol in `AGENT_UNIVERSE` currently trades well above that (AMD ~$514, MSFT ~$495, NVDA ~$225, QQQ ~$731, AAPL ~$300+, AMZN ~$260+, GOOGL ~$340+, META ~$580+) — so `Math.floor(buyDollars/price)` evaluates to `0` for literally every candidate, every single day, and the loop just `continue`s past each one with no record of why.

This is not hypothetical: it is the exact, observed, current state of a real funded account. A user who chose "balanced" and funded $1,000 has an agent that structurally cannot invest a single dollar under it, and nothing in the product tells them that.

## Part 4 — The protective machinery

**Trailing stops are alive and ratcheting correctly.** 185 real ratchets recorded across 282 real watchdog runs (1,155 total position-checks) for the 3 real agents — the ratchet-up-only mechanism is demonstrably running in production, ratchet math confirmed against the documented formula (`stopPct = clamp(base + betaSlope·(β−1), min, max)`, per-risk constants unchanged from the hardening-pass docs).

**🟡 Zero real protective stop-sells have ever fired**, for any real user, across ~8 weeks of continuous watchdog operation. This is not a bug — it's an honest fact worth stating plainly rather than glossing over: the single most safety-critical code path in the whole agent (autonomous selling on a real drawdown) has never been exercised by real market conditions for a real account. Confidence in it currently rests entirely on the deterministic-stubbed-price-path tests documented in HANDOFF's 10.3/hardening notes, not on a real trigger. The observed rationale text repeatedly citing "near 52-week highs" is consistent with a broadly rising market over this window explaining the absence, not a mis-tuned stop — but it means this path is genuinely unproven in production, and that's worth knowing before trusting it at scale.

**Anti-whipsaw is half-working.** The one mechanism that exists (`COOLDOWN_DAYS` after a watchdog sell) has never been tested in production either, for the same reason — nothing has ever triggered it. Meanwhile the *actual* whipsaw happening in production (Part 2's membership churn) runs through a completely different code path that this protection was never designed to cover.

**The drift band is doing its one job correctly.** `DRIFT_BAND = 0.05` genuinely suppresses weight-level noise — confirmed by the very common *"Portfolio within drift bands — no trades needed"* rows, especially on calmer days. It was never designed to suppress *membership*-level noise, and it doesn't; that's the known, already-documented limitation Part 2 confirms is now a real, active problem.

## Part 5 — Cost

**133 successful Claude calls** from the real thinker across all 3 real agents since each one's first run (2026-06-22 through today) — and **100% of them succeeded** (`ai_used=true` on every single one; zero fell back to quant-only). Watchdog makes **zero** Claude calls by design (282 real runs, pure quant/quote loop) — its ~30-minute cadence contributes nothing to LLM spend regardless of frequency.

At this app's own documented upper-bound assumption (`ESTIMATED_COST_PER_AGENT_RUN_USD = 0.05`, `lib/admin/costEstimates.ts`): **~$6.65 estimated total spend** for the agent's thinker across 3 real users over ~8 weeks. Genuinely cheap. Cadence is correct — not over-firing: ~1 run/day/agent, with two isolated extra/manual triggers (noted in Part 1), not a systemic issue.

**🟡 Finding: the admin console's own cost dashboard undercounts real agent spend.** Traced every call site of the `agent_run` analytics event (the thing the admin dashboard counts to estimate agent cost, `lib/admin/functions.ts`): it fires from exactly one place, `lib/agent/functions.ts:118` — the manual **"Run agent now"** button handler. `lib/agent/cron.server.ts`'s `runThinkerForAllAgents` (the actual daily cron, responsible for all 133 real calls counted above) **never fires this event**. The admin dashboard's visible "agent cost" figure is scoped to manual clicks only and structurally excludes every cron-driven Claude call — which, per this audit, is the overwhelming majority of real usage. Whatever number the admin console currently shows for agent cost, the real figure is higher.

## Part 6 — Performance, stated honestly

**All three real agents have underperformed SPY over their respective active windows.** No spin:

| Agent | Risk | Window | Agent return | SPY return (same window) | Result |
|---|---|---|---:|---:|---|
| `9181c80a` | aggressive | 2026-06-22 → 08-15 | **−0.02%** | +4.29% | **Lagged by 4.32pp** |
| `1e0c5ffe` | aggressive | 2026-06-27 → 08-15 | **+3.85%** | +4.77% | **Lagged by 0.92pp** |
| `f491a434` | balanced | 2026-07-01 → 08-15 | **0.00%** | +4.10% | **Lagged by 4.10pp** (never invested — Part 3) |

The closest result (`1e0c5ffe`, −0.92pp) is a near-miss, not a win. The other two are meaningfully behind, and the balanced agent's number is fully explained by the fact that it never placed a single trade. Sample size is small — 3 agents, ~7–8 weeks — nowhere near enough to draw a real skill conclusion in either direction, and it shouldn't be spun into one. The honest summary: **on the evidence so far, real production agents have not beaten a plain SPY buy-and-hold, and one of the three has effectively not participated in the market at all due to a real bug.**

---

## Part 7 — Recommendations, prioritized

### (a) Broken — fix now
1. **✅ Already fixed during this audit:** un-awaited `recordHeartbeat()` calls in `agent-thinker` and `snapshot` cron endpoints (Part 1). Trivially safe, applied.
2. **Small allocations can leave an agent structurally unable to trade, forever, with zero user-facing signal.** This is affecting a real account right now. Minimum fix: when `planRebalance` skips every candidate for affordability (`qty < 1` on every target), log *something* distinguishable from "at target" — e.g. a `hold` decision with `reason: "insufficient capital to buy a whole share of any target"` — so the decision log tells the truth. Better fix: warn the user at fund-time (or continuously, in the UI) when their allocation is below a computed viable minimum for their chosen risk level's guardrails. Best fix: let the agent buy fractional shares, matching how the main manual-trading engine already works — removes the whole class of "priced out" symbols rather than just detecting it.

### (b) High-value, low-effort
3. **Membership-set stickiness/hysteresis.** The exact gap HANDOFF already flagged, now confirmed happening constantly in real production (Part 2). Scope is bounded — `rebalance.ts` already has the right shape of code to extend (it already tracks `cooldown` as a set; extending "recently exited by the thinker itself" into a similar short-lived exclusion, independent of the watchdog-only `COOLDOWN_DAYS`, would directly cut the AMZN-style churn observed here).
4. **Fix the admin cost dashboard to count cron-driven runs**, not just manual clicks (Part 5) — right now it's silently blind to the majority of real spend.
5. **Surface guardrail breaches**, even transient ones, somewhere visible (admin console flag, or a decision-log note) — would have caught both the `1e0c5ffe` under-minimum-holdings moment and the `f491a434` zero-holdings state without requiring a manual audit like this one to notice them.

### (c) Later
6. **A watchdog heartbeat.** Deliberately out of scope in 10.5's first cut; now that this audit shows the loop works correctly but has never fired a real sell, a coarse heartbeat would close the observability gap and let `/api/health` attest to intraday coverage, not just the daily thinker.
7. **Real Claude token/cost metering.** `res.usage` is never read anywhere in the codebase — the entire cost picture (agent + insights) is estimate-only, always. Worth capturing and logging real usage now, before this scales meaningfully past 3 real agent users, even if it's not surfaced anywhere yet.

### (d) Not worth it, right now
8. **Manufacturing a real conservative-risk test case.** Can't observe real conservative behavior without a real conservative user, and creating a fake one just to "prove" a code path that's structurally identical to balanced/aggressive (same scoring function, different constants) and already unit/integration-tested isn't worth it. Revisit if/when a real user actually picks conservative.
9. **Reacting to the SPY-lag numbers by changing the strategy engine.** 3 agents over ~8 weeks is nowhere near enough signal to justify a strategy change. Let it run longer under real conditions before treating Part 6's numbers as anything more than an honest early snapshot.

---

## Part 8 — Agent observability assessment (2026-08-17)

**Trigger:** three items sitting separately in the backlog above — guardrail breaches invisible without a manual audit (7c-5), no watchdog heartbeat (7c-6), `res.usage` never read (7c-7) — plus Part 3's 26-day inert agent, are one problem, not three. The pattern: **we cannot see what the agent is doing.** Assessment only, per instruction — nothing below is implemented.

Two of Part 7's items have shipped since this audit was written (Fix 1a: fractional shares; Fix 1b: honest underfunded signal, decision-log entry + UI banner; Fix 3: `agent_run` now fires from the cron path too, not just the manual button). Where that changes an answer below, it's called out explicitly — this assessment is written against the CURRENT code, not the 08-16 snapshot.

### 1. Could we detect a silent inert agent today, after the fact?

**Partially — and the distinction between "the cron fired" and "the agent decided something" is exactly where it breaks down.**

Three signals exist today, at three different levels of precision:

- **`cron_heartbeats` (job-level).** One row per job (`agent-thinker`), `last_run_at`/`last_status`. Proves the BATCH ran. Says nothing about any individual agent — a batch that runs perfectly while every single agent inside it decides nothing every day looks IDENTICAL to a batch where every agent traded normally. This is coarsest possible signal and structurally cannot answer the user's question.
- **`agent_run` analytics event (per-user, per-run).** Fires once per eligible agent per cron invocation, `properties: { ran, aiUsed, source }`. `ran: true` means the thinker executed to completion **without early-returning** (not set up / not enabled / no cash / no live market data) — it is **true whenever the thinker completes a full cycle, including a cycle that ends in zero trades.** A cron that runs faithfully and decides nothing every single day — the exact case that fooled us — reports `ran: true` on every one of those days. This event cannot distinguish "acted" from "correctly did nothing." (`aiUsed` is closer, but false only for the quant-only fallback path, not for "AI ran, decided to hold.")
- **`agent_decisions` (per-user, per-run, real content).** Every thinker/watchdog cycle writes one or more rows here with a real `action` column: `rebalance`/`watchdog`/`hold` are narrative/no-op entries; `buy`/`trim`/`sell` are the only three values that correspond to an actual trade. **This is the one signal precise enough to answer the question** — `SELECT user_id, MAX(created_at) FROM agent_decisions WHERE action IN ('buy','trim','sell') GROUP BY user_id`, compared against each agent's `agent_cash`/holdings and enabled status, would surface "which funded agents have taken no real action in N days" correctly, including the 26-day case. **This data has existed since the agent schema shipped (0005_agent.sql) — the gap has never been the data, it's that nothing has ever run this query.** Nothing computes it, nothing alerts on it, nothing displays it.

So: **today, retroactively, with a one-off query — yes.** As a standing, automatic answer the product or an operator gets without having to think to ask — no. The precise distinction the user asked for: `agent_run`/`cron_heartbeats` prove liveness; only `agent_decisions.action` proves activity, and only a query nobody has written today actually reads it that way.

One more real gap, worth being precise about: the thinker's `candidates.length === 0` early return (`thinker.server.ts:87`, "No live market data available right now") writes **zero rows anywhere** — not `agent_decisions`, and (pre-Fix-3-era, or if that early return is ever hit today) an `agent_run` event with `ran: false`. A day where this fires would show as a genuine **gap** in an otherwise-daily `agent_decisions` sequence, not a `hold`/`rebalance` row — a different detection shape (missing-day, not stale-day) that the query above doesn't cover as written and nothing today checks for.

### 2. The 26-day window — what signal existed at the time?

**Effectively nothing usable.** Reconstructed precisely, not assumed:

- `agent_run` did not exist on the cron path at all during this window — Fix 3 (wiring `track("agent_run", ...)` into `runThinkerForAllAgents`) shipped AFTER this audit. For a cron-driven agent (all real production usage, per Part 5), there was no per-run event of any kind.
- `agent_decisions` got one row per day: `action: 'rebalance'`, `rationale: "Portfolio within drift bands — no trades needed."` — **the identical text a genuinely healthy, fully-invested, at-target agent would also produce.** `signals` carried no `underfunded` field (Fix 1b post-dates this window) — there was nothing IN the row itself to distinguish it from success, even for someone reading it directly.
- `cron_heartbeats` for `agent-thinker` was itself silently broken for at least part of this window (Part 1's fire-and-forget bug — 5 days stale while the job ran correctly) — so even the coarsest "did the batch run" signal was unreliable some of the time.
- No admin UI existed (still doesn't) that lists agents or their holdings counts.

**Where it would have surfaced, if anywhere: nowhere, without literally reading 26 identical decision rows and independently doing the whole-share-affordability arithmetic by hand** — which is exactly what this audit did, by going looking. There was no shortcut available at the time, not even a query.

### 3. Correctly holding vs. stuck/malfunctioning — can our data tell these apart?

**For the one failure mode we already know about: yes, now. For any other failure mode: no, and that's the important finding.**

What changed since the 26-day window: `plan.underfunded` (rebalance.ts) is computed and stored in `agent_decisions.signals.underfunded`, and surfaced as a UI banner on `/app/agent`. An agent blocked because every target position is smaller than `MIN_TRADE_DOLLARS` ($5, post-fractional-shares) is now explicitly flagged, not silently indistinguishable from health. That specific incident, reproduced today, would be caught immediately and honestly — both in the data and in the UI.

But that flag exists because we found and diagnosed ONE specific mechanism. **The underlying detection strategy is "notice a silent-failure shape, then hand-code a flag for it" — not a general test for correctness.** Concretely, today, a `rebalance` decision with `underfunded: false` and zero executed trades is currently ALWAYS interpreted (implicitly, since nothing reads it any other way) as "correctly at target." That's true for the failure mode we've seen. It is an assumption, not a proof, for:
- a guardrail miscalculation that happens to always conclude "hold" for the wrong reason,
- a quant-scoring bug that produces a degenerate shortlist,
- a data problem (stale prices, a symbol silently dropped from the universe) that isn't severe enough to trigger the `candidates.length === 0` early return but is severe enough to distort every score,
- anything else not yet discovered.

**If our stored data cannot tell these apart — and for anything outside the one already-patched case, it cannot — any alert built purely on "N days since a real trade" would be guessing at WHY, even though it could reliably tell you THAT.** That's fine for a plain-English status line (see §4 below — "hasn't traded in N days" is a true, checkable fact regardless of cause) but would be dishonest framed as a diagnosis ("the agent is stuck") rather than an observation ("the agent hasn't traded — here's the last thing it decided, go look").

### 4. Cheapest honest detection, and where it surfaces

**A. `/app/agent` status line (user-facing).** Compute, from data that already exists (no new storage): days since the most recent `action IN ('buy','trim','sell')` row for this user (or "never" if the agent has holdings=0 and no such row exists since funding). Render as a plain sentence, always visible, not just on the underfunded path:
- Has traded, recently: *"Last real trade: 2 days ago (bought AMD)."*
- Has traded, but a while: *"No trades in 9 days — last rebalance check: portfolio within target, no changes needed."* (pulls the most recent `rebalance`/`hold` rationale verbatim, so the user sees the AGENT's own stated reason, not a synthesized one)
- Never traded since funding, N1+ days in: reuse the existing `underfunded` banner if that's the cause; otherwise the same "no trades yet — last check: {rationale}" pattern.

This is deliberately NOT a health verdict ("your agent is fine" / "your agent is broken") — per §3, we can't always know which. It's an honest activity fact plus the agent's own most recent reasoning, so silence is never ambiguous: the user always knows the LAST thing the agent said, even when that thing is "nothing to do."

**B. Admin list of funded agents idle beyond N days.** One query (§1's `MAX(created_at) WHERE action IN (...)`, joined against `agent_config` for enabled+funded), rendered as a table — no new route infrastructure beyond what a couple of existing admin list pages already establish as the pattern.

**Recommended N — two thresholds, not one, because the two starting states are genuinely different risks:**
- **Never-traded agents (0 holdings since funding): N₁ = 3 days.** A funded, enabled agent with a non-degenerate shortlist should place its first trade within its first daily cycle or two in virtually every real case observed so far (both real aggressive agents' first-run logs show immediate buys). Three consecutive zero-trade days with zero holdings is already unusual enough to be worth a look, and is short enough that it would have caught the 26-day case on day 3, not day 26.
- **Previously-invested agents gone quiet: N₂ = 14 days.** A calm market can legitimately leave a well-diversified, at-target multi-position portfolio untouched for a while — Part 4 already shows drift-band suppression doing exactly this correctly on calm days. Flagging too aggressively here would just manufacture false positives out of healthy behavior. Two weeks with zero `buy`/`trim`/`sell` activity across a multi-symbol portfolio, where daily price movement alone usually nudges SOME weight past the drift band eventually, is a reasonable "worth a look" bar without being noisy. (This is a starting recommendation, not a tuned constant — revisit once there's more than 3 agents' worth of real calm-market baseline to check it against.)

**New data needed: none, for either A or B.** Both are pure read-side — a new query pattern against `agent_decisions`, not a new column or table. The only thing worth ADDING to the schema, if this gets built, is not for detection but for precision: recording which early-return reason (`thinker.server.ts`'s `{ran:false, reason}` branches) fired on a given day would close the "gap day" blind spot from §1, since right now those leave no row at all to explain the gap.

### 5. Cost metering — what would it take to read `res.usage`?

**Small, mechanical, and worth doing — agree with pulling it out of tier-c, with one refinement on where the bar should sit.**

Two call sites, both already sitting on `const res = await client.messages.create(...)` and both currently discarding everything except `res.content`:
- `lib/agent/anthropic.server.ts:70` (`claudeReason`) — the agent's one Claude call per thinker run.
- `lib/insights/insights.server.ts:179` and `:322` — the two insight-generation call sites (per-stock insight, daily brief).

The Anthropic SDK's `Message` response already includes `usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` on every call — no SDK upgrade, no new dependency, no schema change to make it READABLE. The work is: (1) return `res.usage` alongside the existing parsed result from each of the three call sites, (2) thread it up to the caller (`runThinker`, `getStockInsight`/`runDailyBriefs`) instead of dropping it, (3) somewhere to put it — cheapest option is a new column or two on the existing per-call log point (`agent_decisions.signals` already carries a JSONB bag for the thinker; insights already write a row per generation) rather than a new table, since both already have a natural per-call row to attach usage to. Real per-model $/token pricing (a small constant map, Anthropic publishes it) turns raw token counts into an actual dollar figure — replacing `ESTIMATED_COST_PER_AGENT_RUN_USD`/`ESTIMATED_COST_PER_INSIGHT_CALL_USD`'s flat per-call guesses with the real number. Genuinely an afternoon of work, not a project — the SDK does the hard part already.

**Worth noting while in this code:** the admin cost dashboard's `agent_run` count (`admin/functions.ts:388`) already receives an `aiUsed` property on every event (since Fix 3) but doesn't filter or weight by it — every `agent_run` row, including `ran:false`/`aiUsed:false` early-returns, is currently counted at the same flat `ESTIMATED_COST_PER_AGENT_RUN_USD` as a row that made a real Claude call. That's a one-line fix available even before real token metering lands, and would tighten the estimate immediately.

**Pushback on "pull it out of tier-c," partially:** the reasoning is right — it's the only cost that scales with users, and "we'd learn it accelerated when a bill arrived" is a real, not hypothetical, risk at 3 real agents already. But I'd stop short of calling it pre-launch-blocking (see §6) — it's a cost-visibility problem, not a user-safety or trust problem, and at current scale (3 agents, ~$6.65 estimated total spend over 8 weeks per Part 5) there's no live fire to put out. Recommend: **do it soon after whatever ships next, specifically before the user count that makes "an estimate was quietly wrong" turn into a real budget surprise** — not urgent enough to block anything else in flight, but real enough that it shouldn't keep sliding either.

### 6. Pre-launch checklist placement

**Agree with the instinct — user-visible agent status is pre-launch; the rest is real but can follow, with one exception worth flagging.**

- **Pre-launch: §4A, the `/app/agent` status line.** This product asks users to trust it with money-equivalent decisions made autonomously, unattended. "Tell the user honestly what happened last, even when nothing happened" is table stakes for that trust, not polish — and per this assessment it's genuinely cheap (no new data, a read query plus a sentence of UI) once the underfunded banner already established the pattern.
- **Can follow, soon: §4B (admin idle list) and the `agent_run`/`aiUsed` cost-filter one-liner from §5.** Both are internal-operator tools, not user-facing promises, and both are now items a manual query (documented in §1/§4) can already answer by hand if someone remembers to ask — automating "someone remembers to ask" is real value but not launch-blocking value.
- **Can follow, less urgently: guardrail-breach surfacing (Part 7's item 5) and the watchdog heartbeat (Part 7's item 6).** Guardrail breaches observed so far were transient snapshots of the same churn/underfunded issues already covered above, not a new failure class; the watchdog is intraday-only-safety (it can only SELL, never buy, so a missed watchdog cycle is bounded — protection delayed, not money put at risk the way a silently-broken buy path would be) and already leaves SOME trace (a `watchdog` summary row in `agent_decisions` every successful run, per watchdog.server.ts:224 — `/api/health` just doesn't read it), so the gap here is narrower than it first sounds.
- **Real token metering (§5): recommended soon-after-launch, not pre-launch, per §5's reasoning above** — genuinely important, scales with the thing that matters (users), but not a trust-with-money-equivalent-decisions issue the way the status line is, and current spend is small enough that there's no urgency the numbers themselves demand yet.
