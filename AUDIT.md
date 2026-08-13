# PaperTrader — Full Application Audit

**Date:** 2026-08-13 · **Scope:** every shipped feature, walked as a real user, on a fresh account and a seeded account with real trading/margin/options activity. Read-only against production data (5 real users, 6 real accounts incl. admin); all destructive testing used a throwaway account created and deleted during this audit.

This is a findings report for triage, not a build. No code was changed except where explicitly noted as a trivial fix.

---

## Part 1 — Functional audit

Walked every feature end-to-end: landing → signup → login → dashboard (fresh + seeded) → markets → search → stock detail (chart/ranges/scrub/order panel/all 6 tabs) → journal (trade-time capture) → options (unlock quiz → chain → real buy) → margin (enable → real borrow, with disclosure) → AI insight (real Claude call, "Measured History") → simulator (real historical run) → scenarios (picker) → coach (behavioral breakdown) → watchlist → portfolio → settings.

**Everything below is not otherwise flagged is working correctly** — verified with real trades, real DB read-backs, and real dollar reconciliation (see Part 2). Only what's broken, slow, or confusing is called out here.

### Broken / confusing

1. **AI Agent's "Activate agent" toggle has stale, actively misleading copy.** `app/src/routes/app.agent.tsx:321` reads *"Activation takes effect once the engine is live (coming soon)."* This is false: the engine has been live and cron-scheduled since Phase 10 — `app/src/lib/agent/cron.server.ts:83,133` filters directly on `agent_config.enabled = true` to decide which users' sub-portfolios the daily automated run trades. The toggle is fully functional and consequential; the copy tells users it does nothing. This very plausibly suppresses adoption of the flagship AI-agent autonomous mode — a user who reads "coming soon" has no reason to flip it on. **Likely leftover from the original June 19 foundations commit**, never updated when the engine shipped.

2. **Dashboard's "Top movers" widget is 100% fake data**, sitting directly beside real, correct holdings on the same screen. `app/src/routes/app.dashboard.tsx:20,261` imports `topMovers()` from `@/lib/mockData` — a hardcoded stub from the pre-Phase-5 mock era that was never swapped for live data. During this audit it showed **NVDA at $138.07 / +2.56%** in the Top Movers card while the holdings table three inches above it, on the identical page, correctly showed **NVDA at $224.09 / +3.03%** (matching the live price everywhere else in the app). A new user's very first impression of the product — the page they land on right after signup — contains a visibly self-contradictory price for the same stock. This is high-visibility and easy to mistake for a real, current inconsistency rather than what it is (dead mock code).

3. **Simulator's "Buy now" CTA promises the wrong starting balance.** `app/src/components/SimulatorPanel.tsx:191,197` — *"Trade it at today's live price with your virtual $100k"* and *"Sign up to trade with $100k"*. New accounts have started with **$25,000** since the deliberate step-1 change (`profiles.starting_capital`, PLAN.md §C). The simulator is explicitly the public, pre-login viral/conversion hook (per PLAN.md: "never paywall it… the viral hook") — its own CTA copy overpromising by 4× on the one number a converting visitor will check first against their real signup experience is a trust problem, not just a typo.

4. **Options unlock quiz UX**: functions correctly (3-question quiz, instant grading, re-teach on wrong answer, real server-side unlock via `unlock_feature` RPC — confirmed by code and by a live unlock this session) but is easy to click through without reading, since nothing prevents rapid-fire guessing. Minor — not a correctness issue, a comprehension-gate-strength question. Not scored as broken.

5. **Options chain UI**: the deep ITM/OTM strikes at the *nearest* (1-day) expiry show delta exactly `1.00`/`0.00`/`-1.00` — a pre-existing floating-point saturation artifact in `blackscholes.ts`, already identified and flagged as a separate background task before this audit (not re-litigated here; see that task for detail). Cosmetic — the premiums themselves are correct, only the displayed delta rounds to the boundary.

### Working correctly (with evidence)

- **Auth**: signup, login, session persistence, logout all clean.
- **Dashboard**: empty state (fresh account) and populated state (seeded account) both correct — $25,000 starting balance, 0 holdings, correct empty watchlist/brief copy.
- **Markets**: live prices, correct "Market closed — showing last close" badge, sector filters, subtle options-chain entry point (`[ ]` icon) all render and reconcile.
- **Stock Detail**: chart renders across all 6 range toggles; Key Stats (Open/High/Low/Prev close/Market cap/52-wk range) all populated, no `—`/NaN; order panel (Market order, Shares↔Dollars toggle, live estimated cost, live buying power) all correct; all 6 tabs (Your position, Options, News, About, Recent trades, Journal) present and populated once there's data.
- **AI Insight**: real Claude-generated lean/drivers/risks plus the "Measured History" block (deterministic, computed from real price history, explicitly labeled "not AI-recalled") rendered correctly for NVDA with real numbers (35 historical instances, median -1.3%, etc.).
- **Trading (stock)**: real buy executed via the UI, `ConfirmDialog` showed exact math before confirming, cash/holdings/transactions all landed correctly in the DB, dashboard/portfolio/stock-detail all reconciled to the cent afterward.
- **Journal trade-time capture**: the "Why this trade?" prompt appears immediately after a real trade, saves correctly, confirmed via toast and DB.
- **Options**: unlock flow real (server-verified via `unlock_feature` RPC), chain browses correctly across all 6 expiries, a real contract (`AAPL-2026-09-18-C-300`) was bought via the UI, landed in `option_positions`, and **the `option_trade` analytics event fired correctly** — this resolved an open question from Part 5 below (see there).
- **Margin**: enable flow (real confirmation dialog with the correct risk copy), a real $30,000 NVDA buy against $23,290.75 cash correctly triggered the borrow-split disclosure dialog (*"This would draw about $23,290.75 from cash and borrow about $6,709.25 on margin"*) and the resulting `margin_loan` in the DB matched to the cent. Buying power (`2×equity − positions`), equity (`cash + positions − loan`), and maintenance requirement all recomputed correctly across the Margin page, the order panel, and the stock detail page after every state change.
- **Portfolio**: allocation, holdings detail, options section, and transaction history all reconciled exactly against the DB and against every other page showing the same numbers.
- **Coach**: real behavioral breakdown computed from the seeded account's actual trades — correctly reported "not enough data yet" for 5 of 6 patterns (honest, no fabricated numbers) and correctly flagged the one pattern that *did* have enough data (NVDA at ~99% concentration, n=2).
- **Simulator**: a real historical run ($5,000 in NVDA from Jun 3, 2019) returned correct real numbers ($335,012.70, +6600.25%, vs. SPY +181.35%) with a working comparison chart.
- **Scenarios, Watchlist, Settings**: all render cleanly with correct empty states; Settings correctly shows the current $25,000 default in its own reset-account copy (the $100k error is isolated to the Simulator component, not systemic).
- **Admin console**: not re-tested live in this pass (would require a temporary admin grant, which only a superuser SQL session can issue — a deliberate constraint, see `0026_admin_console.sql`). Already comprehensively verified in the prior session (40+ automated checks plus a live browser walkthrough including the non-admin-direct-call rejection proof); treated as known-good here rather than re-verified redundantly.

---

## Part 2 — Data/correctness spot-checks

Reconciled dollar-for-dollar across Dashboard, Portfolio, Stock Detail, and Margin for a real seeded account carrying a stock position, an option position, and an active margin loan simultaneously:

| Figure | Dashboard | Portfolio | Margin page | Stock detail | Match |
|---|---|---|---|---|---|
| Total equity | $25,000.00 | — | $25,000.00 (equity) | — | ✅ |
| AAPL position value | (in $25,000 total) | $302.25 | (in positions value) | $302.25 | ✅ |
| NVDA position value | (in $25,000 total) | $30,000.00 | (in positions value) | $30,000.00 | ✅ |
| Options value | (in $25,000 total) | $1,407.00 | (in positions value $31,709.25) | — | ✅ |
| Margin loan | (nets out of equity) | — | $6,709.25 | — | ✅ |
| Today's $ change | +$724.55 | — | — | AAPL −$2.66/sh, NVDA +$6.59/sh | ✅ (verified by hand: Σqty×dayChange for stocks = +$879.57, plus the option's own Black-Scholes day-reprice against AAPL's day range ≈ −$155 — consistent, not a bug) |

No `NaN`, no `undefined`, no stray `—` where a real value should exist, anywhere in this pass. Loading/empty states checked on: fresh Dashboard, empty Watchlist, empty Scenarios progress, empty Journal-linked positions, Coach's per-pattern "not enough data" gates (6 of 6 render an honest sample-size message rather than a fabricated stat below their documented threshold) — all clean.

**One data-quality finding, not a UI bug:** `analytics_events` "signup" count is heavily inflated (213 rows) relative to real distinct users (6) — see Part 5. This doesn't affect anything user-facing, but it means anyone querying that table directly for a "real signups" number today would be badly misled without knowing the context.

---

## Part 3 — Discoverability

Venky's own prompt for this audit ("stock news… same problem as options") is itself evidence: a feature can be fully built, fully working, and effectively invisible. Systematic pass:

### The landing page is the single biggest gap
The marketing feature grid (`app/src/routes/index.tsx:128-133`) lists exactly **6 items**: Live-feeling markets, What-if simulator, Portfolio analytics, Watchlists & movers, Risk-free by design, Built for learning. It says **nothing** about: **Options, Margin, the AI Agent, AI Insights, the Trade Journal, Adaptive Coaching, or Scenario Challenges** — seven built, working, differentiated features, several of which (the AI agent, scenario challenges) are called out elsewhere in the project's own planning docs as the *strongest* parts of the product ("Venky rates this the most exciting item in the plan" — scenario challenges, PLAN.md §6 step 9). A visitor deciding whether to sign up has no way to know any of this exists. This is a bigger discoverability problem than any single in-app tab, because it happens *before* signup, where there's no sidebar at all to fall back on.

### Inside the app, the sidebar is comprehensive but flat
Once logged in, every major feature **does** have a nav entry (Dashboard, Markets, Simulator, AI Agent, Portfolio, Margin, Options, Journal, Coach, Scenarios, Watchlist, Settings — 12 items). This is good; the earlier Options-specific fix (dedicated `/app/options` page + nav entry, PLAN.md §6 step 4) generalized correctly to every other feature. The remaining problem is *hierarchy*, not *existence*: 12 flat, equal-weight items give a brand-new user no signal about what to try first. A first-time user has no way to distinguish "core, try this today" (Dashboard, Markets, Portfolio) from "advanced, unlocks later" (Options, Margin) from "differentiators worth knowing about" (AI Agent, Scenarios, Coach) just by looking at the list.

### Specific still-buried features (the direct "News tab" analog)
- **Stock News** is exactly one of 6 tabs on the Stock Detail page (Your position / Options / News / About / Recent trades / Journal) — real content (10 real headlines with sources and working links, confirmed this session), zero surfacing anywhere else. No "News" nav entry, no news snippet on Dashboard, no indicator that news exists until a user is already on a specific stock's page and clicks through tabs. This is the literal case Venky named.
- **AI Insight** requires a manual "Get AI insight" click per stock, per day — there's no passive surfacing (e.g., a badge on Markets/Watchlist rows saying "AI take available"). A user who doesn't scroll down on Stock Detail and notice the button will never see it.
- **The Coach's per-pattern lessons** are only reachable by navigating to `/app/coach` directly; nothing elsewhere in the app (Dashboard, Portfolio) hints "we noticed something about your trading, come look."
- **Journal** is discoverable reactively (the trade-time "Why this trade?" prompt is a strong, well-placed nudge — confirmed working this session) but has no *proactive* surfacing for a user who skips that prompt every time.

### Not a discoverability problem (working as intended)
- Admin console correctly has **zero** discoverability for non-admins (that's the security design, not a bug — the nav item itself is explicitly documented as UX-only, never the security boundary).
- The subtle options-chain `[ ]` icon on Markets rows is a good, low-friction secondary entry point, in addition to the dedicated Options page.

---

## Part 4 — Stock page enrichment ("Robinhood-style" key stats)

**Current state:** `finnhub.server.ts` already calls `/stock/metric?symbol=X&metric=all` for every symbol (used today for 52-week high/low) — the full response is fetched and **almost entirely discarded**. `Key stats` on Stock Detail today shows only 6 fields, all from the basic `/quote` + partial `/stock/metric` extraction: Open, Day high, Day low, Prev close, Market cap, 52-wk range.

### What's actually in the payload (probed live, 3 diverse real symbols, zero new API cost — this reuses the exact call already being made)

| Field | AAPL (mega-cap) | VOO (ETF) | SOFI (mid-cap, unprofitable) |
|---|---|---|---|
| Total metric keys returned | 133 | **19** | 100 |
| P/E (TTM) | 34.72 | missing | 36.78 |
| EPS (TTM) | $8.72 | missing | $0.47 |
| Dividend yield | 0.35% | missing | missing (pays $0) |
| Net profit margin (TTM) | 27.6% | missing | **−19.8%** (real, unprofitable) |
| ROE (TTM) | 137.2%* | missing | 6.2% |
| Debt/Equity | 1.35 | missing | 0.17 |
| Revenue growth (TTM YoY) | 14.2% | missing | **205.5%** (real hypergrowth) |
| Beta | 1.07 | 1.02 | 2.35 |
| P/S (TTM) | 9.59 | missing | 3.35 |
| Book value/share | $4.99 | missing | $8.26 |
| Market cap (from this same call) | $4.48T | missing | $23.4B |

*(AAPL's headline ROE looks extreme because of buyback-driven negative/low book equity — a known real-world artifact of this metric for AAPL specifically, not a data error.)*

**Pattern, confirmed not assumed:** mega-cap stocks and mid/small-caps get rich fundamentals (100–133 fields). **ETFs get almost nothing** (19 fields, all price-return/volatility statistics — no P/E, no margins, no market cap even) — because ETFs don't have their own per-share earnings or debt structure; this is a true data-availability limit, not a bug in our extraction. `/stock/profile2` is also empty for ETFs (already known and already worked around for the *name* field via `resolveSymbolName`, per HANDOFF).

### Proposed "Key stats" layout — zero new API cost
Extend the existing card with a second row, populated from fields already sitting in the same cached `/stock/metric` response:

**Row 2 (stocks with fundamentals):** P/E (TTM) · EPS (TTM) · Dividend yield · Net margin · ROE · Debt/Equity · Revenue growth (YoY) · P/S

**Row 2 (ETFs — different fields, since the above are structurally empty):** Beta · 52-wk price return · vs-S&P-500 (13-wk/YTD, both already in the payload as `priceRelativeToS&P50013Week` / `...Ytd`)

Show `—` (already the app's convention) for any missing field rather than hiding the row — this is itself informative (e.g., "Dividend yield: —" on SOFI honestly says "doesn't pay one," not "we don't have the data"). No new provider call, no new cache key, no new rate-limit exposure — this is purely extracting more fields from a response already in memory.

### What we genuinely cannot provide on current tiers, and what it would cost
- **Analyst ratings / price targets, earnings-surprise history, earnings-call transcripts**: Finnhub's own paid tiers (**$11.99–$99.99/mo**, per finnhub.io/pricing as of this audit) add these plus international coverage and higher rate limits — the *cheapest* useful step up, since it's the same provider already integrated.
- **Next-earnings-date calendar**: same Finnhub premium tier likely covers this; not separately priced-out here.
- **Real-time options quotes** (vs. today's Black-Scholes-modeled premiums): this is a fundamentally different, more expensive data category — specialized options-data vendors (OPRA-feed resellers) rather than a Finnhub tier bump. Not estimated here with a specific number since it wasn't verified against a current quote; worth a dedicated pricing pass if/when real options data becomes a priority, but likely a meaningfully larger recurring cost than the Finnhub step-up above.

---

## Part 5 — Usage data (aggregate only; journal content never queried, no per-user detail below)

Queried `analytics_events`, `rate_limit_events`, and row counts across every feature table.

### Headline numbers
- **17 profiles exist today.** Of those, only accounts created **on or after 2026-08-10** have any `signup` event at all — tracking shipped that day (step 5), so anyone who signed up earlier (including some real users) has zero signup-event history. This isn't a bug, just a fact to know when reading anything below.
- **213 `signup` events total, but only 6 distinct (non-null) `user_id`s attached to them.** The other ~207 belong to accounts that were later deleted (verify-script throwaway users from this build sprint) — `analytics_events.user_id` is `ON DELETE SET NULL` by design (so aggregate historical counts don't shrink when someone deletes their account), so those rows survive with the identity stripped. **The raw "213 signups" number is not usable as-is for a real growth metric** — it's dominated by test-account churn from the Aug 10–13 build window, not real visitors. The 6 distinct signup-owners are very plausibly the real people (5 users + the admin account), not a meaningful sample size either way.
- **`first_trade`: 4 events, `agent_run`: 12 events, `insight_viewed`: 3 events, `option_trade`: 0 events (before this audit) / 1 (after — see below), `rate_limited`: 8 events.**
- **`option_trade` = 0 was investigated, not assumed to be a bug.** A real UI-driven option purchase during this audit fired the event correctly and immediately (confirmed in the DB, timestamped to the millisecond after the trade). The pre-audit zero is fully explained: every one of the 19 pre-existing `option_transactions` rows in the database was created by `verify-*.ts` scripts calling the underlying RPC **directly** (the documented, intentional pattern for those scripts — see `verify-harness.ts`'s own header), bypassing the real server function and its `track()` call entirely. **Not a tracking bug** — a data-seeding artifact of how verification scripts are built, now confirmed rather than assumed.
- **Real feature-adoption row counts** (across all 17 profiles, real + leftover test accounts mixed): `holdings` 6 rows, `transactions` 26, `watchlist` 2, `option_positions` 4, `option_transactions` 19, `agent_config.enabled=true` 9, `profiles.margin_enabled=true` 6, `scenario_runs` **0** (nobody — real or test — has ever started a scenario challenge), `insights` 88 rows (shared per-symbol-per-day cache, not a per-user count).

### What this can and can't tell you
- **Can't currently produce a trustworthy "how many real users signed up, and did they activate" number** from `analytics_events` alone, because it isn't yet possible to distinguish real accounts from `pt-*@example.org` test accounts in that table (the profiles table has no such distinction either — a `is_test_account` flag or an email-domain check in the admin dashboard would fix this cheaply).
- **Zero scenario-challenge engagement** (0 runs, real or test) is worth noting given it's flagged internally as the strongest differentiator — either genuinely no one has tried it yet, or it's suffering from exactly the Part 3 discoverability problem.
- **Instrumentation gaps**: only 5 of the ~13 major features have a dedicated analytics event at all (signup, first_trade, insight_viewed, agent_run, option_trade — plus rate_limited, which is an abuse signal not a feature-usage one). Journal entries written, scenario runs started, coach-page visits, watchlist adds, and margin-enable events are **not tracked anywhere** — any usage question about those features today can only be answered by raw row counts (no time-series, no per-user activation view).

---

## Part 6 — Recommendations

### (a) BROKEN — fix now
1. **Dashboard "Top movers" is fake data** (`app/src/routes/app.dashboard.tsx:20,261`, `lib/mockData`). Highest priority — it's on the first page every user sees, shows a self-contradicting price for a symbol shown correctly two inches away, and is trivial to fix: swap in the same live-quotes pipeline every other page already uses (Markets, Watchlist). This is the single most embarrassing bug in the app if a user ever notices it.
2. **Simulator's stale "$100k" CTA copy** (`SimulatorPanel.tsx:191,197`) — two-line text change, but it's on the public conversion page and overpromises by 4× the real starting balance.
3. **AI Agent "coming soon" copy** (`app.agent.tsx:321`) — one-line copy fix, but actively hides a fully working, cron-scheduled feature from every user who reads it.

*(All three are small, targeted diffs — none require design or data-model work. Recommend doing them together as one tiny PR.)*

### (b) HIGH-VALUE, LOW-EFFORT
4. **Extend Key Stats with the already-fetched fundamentals** (Part 4) — zero new API cost, meaningfully closes the "Robinhood-style" gap Venky asked about, and is a pure additive UI change to a card that already exists.
5. **Rewrite the landing page's feature grid to mention all 8 major features**, not 6 — no code risk, directly addresses the biggest discoverability gap found, and costs nothing but copywriting. Given the AI agent and scenario challenges are internally rated the strongest/most exciting parts of the product, leaving them off the page visitors decide from is pure lost conversion upside.
6. **Group the sidebar into 2–3 visual sections** (e.g., "Trade" / "Learn" / "Account") instead of one flat 12-item list — a CSS/markup change to `AppSidebar.tsx`, no new data or logic, gives new users an immediate sense of what to try first.
7. **A small "News" or "AI take" indicator on Markets/Watchlist rows** for symbols with fresh news or a cached insight — reuses data already being fetched for other pages, addresses the exact "News tab is invisible" problem named in the kickoff.
8. **Add an `is_test_account` boolean (or equivalent email-pattern view) to the admin usage dashboard** so cost/usage numbers can honestly separate real users from verification-script accounts going forward — cheap, and Part 5 shows the current numbers are actively misleading without it.

### (c) Worth doing later
9. **Instrument the remaining ~8 features** (journal entries, scenario starts, coach visits, watchlist adds, margin enable) with the same lightweight `track()` calls already used elsewhere — real usage data for the moat features (journal, coaching, scenarios) doesn't exist today, and those are exactly the features PLAN.md identifies as the differentiators worth optimizing.
10. **Proactive surfacing for Coach and Journal** — a small "we noticed something" nudge on Dashboard/Portfolio, rather than requiring a user to remember `/app/coach` exists. Design work, not urgent.
11. **Investigate zero scenario-challenge engagement** once instrumentation (item 9) exists — right now it's impossible to tell whether that's a discoverability problem or genuine disinterest, and those call for very different responses.
12. **Finnhub premium tier ($12–$100/mo)** once there's a concrete reason to want analyst ratings / earnings-surprise history — not urgent pre-monetization, but cheap enough to revisit anytime, unlike the options-data-feed cost.

### (d) Explicitly not worth it right now
- **Real-time options market data.** The current Black-Scholes-modeled chain is clearly disclosed as modeled, not live-quoted, and is core to the product's honest "educational simulation" framing. Real options data is a meaningfully larger, specialized recurring cost with no clear payoff before there's real user demand for it — revisit only if users specifically ask, not proactively.
- **A full analytics platform migration** (PostHog/Plausible/etc.) to fix the Part 5 gaps. The existing first-party `track()` abstraction was deliberately built to make this a one-file swap later (per its own HANDOFF documentation) — extending it with more event calls (item 9) is far cheaper right now than migrating tooling, and the actual gap is event *coverage*, not the pipe it flows through.
- **Fixing the options-chain delta-saturation cosmetic artifact as part of this audit** — already tracked as a separate, scoped background task; re-solving it here would duplicate work already in flight.

---

## Appendix — Method notes
- Functional walkthrough used one throwaway account created and destroyed during this audit (`pt-audit-walkthrough-…@example.org`), seeded with real trades (stock, options, margin borrow) via the actual UI, never via direct DB writes. Deleted at the end of this audit; zero rows remain for it anywhere.
- All destructive actions were gated behind an exact-email-match assertion against the throwaway account before execution — the 5 real user accounts and the real admin account were never at risk and were not touched at any point (confirmed by profile count before/after: 17 → 17 after cleanup, since one throwaway was created and removed).
- Every script used to query the database for this audit routed through the project's standing verification harness (`verify-harness.ts`) for timeout protection, per the project's own hardened-scripting rule, and was deleted after use.
- `journal_entries` was never queried — no `service_role` grant exists on that table by design (a separate, deliberate privacy boundary from step 6), and this audit didn't need to touch it to reach its conclusions.
