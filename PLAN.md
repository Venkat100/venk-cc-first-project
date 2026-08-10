# PaperTrader — Product & Engineering Plan (v1)

**Written:** 2026-08-04 · **Owner:** Venky (product) · **CTO:** Claude (Cowork) · **Implementation:** Claude Code
**Goal shift:** from "personal project that works" → **a real product strangers pay to use**, web first, mobile later.

---

## 0. Where we stand today

**Live at https://mypapertrader.com.** Feature-complete as a simulator:

| Area | State |
|---|---|
| Market data | Real. Hybrid Finnhub (quotes/search/profile/news/fundamentals) + Twelve Data (historical candles). Rate-limited, deduped, in-memory TTL cache. |
| Trading | Server-side atomic execution, fractional shares, dollar-based investing, append-only ledger, weighted-average cost. |
| Options | Black-Scholes pricing engine, generated chains, buy/sell-to-close, automatic expiry cash-settlement. |
| Margin | Opt-in 2× leverage, daily interest, maintenance requirement, simulated margin calls with auto-liquidation. |
| AI agent | Autonomous sub-portfolio: quant scoring + Claude news reasoning, trailing stops, gentle rebalancing, approve-first mode, on autopilot via cron. |
| AI insights | Per-stock lean/drivers/risks + a measured event-study "what actually happened after moves like this" + daily market brief. |
| Simulator | Public what-if backtest vs SPY. |
| UX | Chart scrub + per-range readouts, confirmations on every money action, mobile/tablet polished. |
| Security | RLS on every user table, server-computed prices, service-role-only money functions, keys server-only. 15 migrations. |

**Gaps blocking real users:** no password reset · no admin tooling · no payments · no error monitoring · no legal pages · no per-user rate limits · no analytics · no onboarding.

---

## 1. Corrections to the original brief (decided)

1. **Multi-tenancy already exists.** Row-Level Security isolates every user on every table, proven repeatedly in verification. Nothing to build. (An *organizations* layer — classrooms/teams — is a different, deferred thing.)
2. **"Increase risk for users who are succeeding" is rejected as specified.** Rewarding a winning streak with more leverage teaches overconfidence — the single most common way real traders lose money — and a hot streak in paper trading is statistically meaningless. **Replaced with adaptive *coaching*:** measure real behaviour (diversification, position sizing, holding period, loss-chasing, over-trading), teach to it, and gate advanced instruments behind demonstrated understanding rather than recent luck.
3. **Issue tracking = GitHub Projects, not Jira.** No Jira connector exists, so every ticket update would be manual; `gh` CLI is already installed + authenticated, so Claude Code can file/close issues itself and link them to commits ("Fixes #23"). Free, self-maintaining, migratable to Jira later if collaborators arrive.
4. **Spend engineering before money.** The durable Postgres price cache is free and estimated worth ~10–50× more concurrent users than the current in-memory cache (which dies on every serverless invocation). Upgrade tiers only once that's saturated.

---

## 2. Standing constraints & risks (the things that actually bite)

- **Data-tier ceiling.** Finnhub 60 req/min and Twelve Data ~8 credits/min are shared across ALL users. Twelve Data is the sharper constraint (charts + simulator). Durable cache is the fix; paid tier is the follow-up.
- **AI cost per user.** Per-stock insights are shared globally (1 call/symbol/day — good). But the **daily brief is 1 Claude call per user per day** and each **AI agent is 1 call/day**. These scale linearly with users and need caps/tiering.
- **Vercel Hobby forbids commercial use.** Charging money requires Vercel Pro (~$20/mo). Also unlocks >2 cron jobs.
- **Legal/regulatory (raise before public paid launch).** Paper trading is clearly educational. AI-generated bullish/bearish leanings on real securities, sold to strangers, sits closer to investment-advice regulation. Not legal advice — but worth an actual attorney's hour before monetizing. Navigable via framing, disclaimers, and possibly gating.
- **Abuse surface.** Public signup + paid AI calls = budget-burn risk. Per-user rate limits required before open signup.
- **Support/ops.** No error monitoring today; a stranger hitting a bug is invisible to us.

---

## 3. The plan

### Phase A — "Can strangers actually use this?" (P0 — blocks open signup)
- **A1. Account management.** Forgot-password + reset flow, change password, change email (with re-verification), profile page, delete account. *This alone blocks everything: today a locked-out user is locked out forever.*
- **A2. Abuse & cost guards.** Per-user rate limits on AI endpoints and market-data-heavy paths; sane global caps.
- **A3. Ops visibility.** Error monitoring (Sentry free tier), a health check, and basic product analytics (privacy-respecting).
- **A4. Legal surface.** Terms of Service, Privacy Policy, expanded disclaimers, cookie/consent as needed.

### Phase B — The moat (what makes this worth paying for)
- **B1. Trade journal / notes.** Per-trade and per-position notes, plus free-form journal entries. *Serious traders keep journals; nobody combines journal + paper trading + AI feedback well. This is the strongest idea in the brief.*
- **B2. Behavioural analytics.** Name the user's own patterns back to them from their real ledger: disposition effect (selling winners, holding losers), over-trading, concentration risk, revenge trading, win rate vs. risk-adjusted return.
- **B3. Adaptive coaching + progressive unlocks.** Skill assessment from behaviour; beginners get fundamentals; options and margin unlock behind short explainers/checks rather than being available to a day-one novice.
- **B4. Super-admin console.** User list, search, suspend/delete, impersonate-for-support (audited), usage and cost dashboards, later revenue reporting.

### Phase C — Business
- **C1. Payments.** Stripe subscriptions, plan tiers, entitlement enforcement server-side.
- **C2. Admin revenue reporting.** MRR, churn, per-user cost vs. revenue (AI + data cost attribution).

#### C — Monetization model (DECIDED 2026-08-04)

**Starting capital drops from $100,000 → $25,000 — on EDUCATIONAL grounds, not monetization.** $100k is unrealistic for beginners and removes the need to think about position sizing (everything fits). $25k forces real sizing discipline while keeping options usable (one contract ≈ $200–2,000) and margin meaningful. $10k was considered and rejected as too low for the options/margin feature set. Existing accounts keep their balance; Reset now returns to the current default (update the reset dialog copy accordingly).

**❌ REJECTED: selling virtual cash (e.g. $5 for $10k).** Venky proposed it; CTO pushed back, Venky agreed. Reasons: (1) it destroys the core lesson — if you can buy your way out of a blown-up account, you remove the consequence that teaches risk management, and you actively train "losses don't matter, just add money," the same psychology we rejected when we killed "reward winners with more risk"; (2) it competes with the free Reset button we just built, so it would only work by crippling reset — user-hostile; (3) low willingness-to-pay for an obviously fake number, and it makes a serious finance tool read as pay-to-win; (4) on mobile it becomes an in-app purchase (30% Apple cut + extra scrutiny on virtual currency in a trading app).

**✅ PAID INSTEAD (same instinct, no corruption of the lesson):**
- **Multiple portfolios** — free = 1; paid = several, so a user can run conservative vs. aggressive strategies in parallel or test a thesis without touching their main account. Near-zero marginal cost to us.
- **Configurable starting capital** — a *setting*, not a purchase. Paid users pick their stake ($1k–$1M) to simulate different situations ("what if I only had $2k?" / "what if I managed $500k?"). Enables scenarios; never rewards failure.
- **Scenario challenges** — "Trade the 2008 crash," "Trade March 2020": fixed stake, real historical data, graded outcome. Strong differentiator, runs on infrastructure we already have (historical candles + the simulator engine). Venky rates this the most exciting item in the plan.

**Tier sketch (validated 2026-08-04):**
- **Free forever** (cheap for us to serve → protects growth): paper trading, portfolio tracking, watchlists, basic charts, trade journal, and the **public what-if simulator** (the viral hook — never paywall it).
- **Pro (~$8–15/mo)** (features with real per-user marginal cost + what serious users want): the AI agent, unlimited AI insights (free tier gets a few/month), options + margin, behavioural analytics, multiple portfolios, configurable capital, scenario challenges.
- **(later) Educator/team** per-seat.

**Architectural consequence — build now, not later:** entitlement checks ("does this plan allow this?") and usage metering ("how many AI calls this month?") should be designed in as we build Phase B, not retrofitted across a dozen features in Phase C.

### Phase D — Scale
- **D1. Durable Postgres price cache.** *Do this early — it's free and it's the single biggest capacity unlock.*
- **D2. Paid data tier** once D1 is saturated.
- **D3. Vercel Pro + infra hardening** (required at monetization).

### Phase E — Mobile
Revisit once web is proven. Likely React Native or a wrapped PWA — decide then, based on what mobile actually needs to do.

---

## 4. Market ideas worth exploring (beyond the brief)

- **Educator / classroom mode.** A teacher runs a cohort, sees a group dashboard, sets challenges. Underserved, better unit economics, different buyer. Deferred but the strongest B2B path.
- **Risk-adjusted leaderboards.** Rank by return *per unit of risk*, not raw return — teaches the right lesson and avoids rewarding reckless gambling.
- **Shareable simulator results.** The what-if simulator is inherently viral ("$5k in NVDA in 2019 → $315k"); public, pretty, shareable result cards are a cheap growth loop.
- **Weekly challenges / streaks** tied to good behaviour (diversification, journaling) rather than raw returns.

---

## 5. Working agreements (carried forward)

- Small verifiable chunks; commit per chunk; **never push without CTO review**.
- Definition of done = proof on diverse/adversarial inputs, DB read-backs on money paths, no happy-path-only claims.
- No patch jobs — fix the general class, not the reported instance.
- Serverless-aware: in-memory state does not survive invocations.
- Hardened verification harness (per-step timeouts, timestamped logs, foreground pty, try/catch + process.exit); kill anything silent >10 min.
- Secrets server-only; every phase ends with a client-bundle grep.
- **Every new asset/liability type must enumerate EVERY derived figure it touches** (totals, %s, charts, snapshots, exports) — the equity-bug lesson.
- HANDOFF.md stays the living memory; PLAN.md is the strategic layer above it.

---

## 6. BUILD ORDER — the actual queue (CTO-sequenced 2026-08-04, Venky delegated)

Sequencing logic: unblock strangers first → build the scaling foundation *before* users arrive (not during) → then the moat → then money. Each step is independently shippable.

| # | Item | Why here |
|---|---|---|
| **1** | ✅ **A1 — Account management** + starting capital $100k→$25k | **DONE (commits `b3bbc38`/`272d822`/`9b823f8`).** Forgot/reset password, change password, change email, delete account (FK cascade across 16 tables). `profiles.starting_capital` made PER-USER (migration `0016`) — existing accounts backfilled to $100k so their total-return math stays honest; new default $25k. **Caught a production-breaking bug pre-ship:** the PKCE-configured client never auto-processed the hash-fragment tokens Supabase's real recovery emails deliver → every genuine reset link would have read "invalid or expired." Found by replaying a real freshly-issued link, not a simulated one. GitHub Project board live at github.com/users/Venkat100/projects/1 with all 12 issues filed. |
| **2** | ✅ **D1 — Durable Postgres price cache** — **DONE.** Migrations `0017` (grant consistency: service_role SELECT on `transactions`, DELETE on `insights`) + `0018` (`price_cache`, RLS-on, service-role-only, prunable). Two-tier L1(memory)+L2(Postgres) wired into every provider call; all public signatures unchanged. **Measured headline: 20 cold invocations of the same symbol → EXACTLY 1 provider call (0→1).** TTL expiry, error non-poisoning, and the 7-day prune all verified. Also definitively closed the step-1 gap (`transactions` cascade proven 1→0 by direct read, not inferred), and the full regression run caught + fixed 3 real regressions the $25k change had introduced into the test scripts. | Pulled FORWARD from Phase D. Free, and the single biggest capacity unlock (~10–50×). Decouples user count from the provider rate limit entirely: N users watching AAPL = 1 provider call, not N. Must exist before growth, not after. |
| **3** | ✅ **Live prices + live intraday chart** — **DONE.** 15s polling through our own cache, gated on market-hours AND tab-visibility, tick-flash (respects prefers-reduced-motion), "Market closed" badge everywhere, live-extending 1D chart. **Measured: 20 users on 1 symbol for 2 min = 4 provider calls (not 160); 5 symbols × 4 users = 16 calls — scales with SYMBOLS, not users.** Both gates browser-proven as hard stops (zero polling when closed/hidden, resumes within one interval). Scrub readout proven byte-identical while 10 background updates fired. | The visible payoff of #2 — a static price feels dead in a trading app. ~15–30s refresh, chart extends through the day, tick flash, polls only during market hours. Nearly free ON TOP of #2; prohibitively expensive without it. (True tick-level WebSocket streaming is a later upgrade: Finnhub's free tier includes it, but Vercel serverless can't hold persistent connections → needs a ~$5/mo always-on relay, and the key can't go in the browser.) |
| **4** | ✅ **Options discoverability** — **DONE.** Three entry points now: `/app/options` global page (all-symbol positions + inline chain browser, deep-linkable via `?symbol=`), sidebar + mobile nav entry, and a subtle chain icon on every Markets row. Reused `getOptionPositions()`/`OptionChainView`/`OptionOrderPanel` verbatim; Stock Detail's tab confirmed untouched by git diff. Verified: real NVDA call + VOO put reconciled to the cent across the new page, Portfolio, and each Stock Detail tab ($718.00 total), DB read-backs on buy and sell-to-close, empty state + 375px/desktop screenshots. | Venky couldn't find options at all — they're only a tab on Stock Detail. A feature nobody can find may as well not exist. Add an Options nav entry / global view (positions + symbol picker to browse chains), and surface from Markets. Small. |
| **5** | ✅ **A2/A3/A4 — abuse guards + ops visibility + legal surface** — **DONE**. Per-user rate limits (10/5min+50/day insight, 3/5min+20/day agent run), atomic Postgres enforcement (advisory-lock-guarded, can't be bypassed by a direct/tampered call — proven), Sentry wired with a real DSN (delivery confirmed), `/api/health` (DB + market-data + cron-freshness), first-party analytics with a 90-day prune. **Measured: a real burst hit rejected the 4th call with a DB-proven stop at exactly 3 rows; a raw RPC call bypassing the app entirely was still rejected; a counter survived a genuinely separate process (cold-start proof).** Found + fixed a real bug (`analytics_events` missing its DELETE grant, silently failing the prune) via migration `0021`. Re-verified the delete-account invariant for 2 new tables. **A4 — legal pages wired**: `/terms`, `/privacy`, `/disclaimer` render the finalized drafts (Vite `?raw` import + `react-markdown`, content stays editable by just editing the `.md` files), linked from a shared `SiteFooter` on the landing page, the app shell, and the legal pages themselves. Signup requires a checkbox (blocked client-side) AND records `terms_accepted_at`/`terms_version` server-side via migration `0022` extending `handle_new_user()` — a DATA INTEGRITY gate (no profile can exist without a consent record), not a security control (the field is client-supplied, so this doesn't stop a determined bad actor, only a bug in our own form). Tampered-bypass proven server-side via a raw call to Supabase's signup endpoint omitting the field → rejected, zero `auth.users` row created. | Per-user rate limits on AI endpoints, error monitoring (Sentry free), analytics, Terms/Privacy/disclaimers. **All landed before open public signup.** Entity: Venkat Praveen · jurisdiction: State of Texas, USA · contact: support@mypapertrader.com · **min age set to 18** (deliberate: under-18 pulls in COPPA + stricter GDPR consent; revisit if classroom mode happens). Still to do: **have a lawyer review before charging money** (the AI-analysis sections sit near financial-advice regulation). ⚠️ **support@mypapertrader.com is NOT yet active** — does NOT affect password reset (Supabase sends those), but the Privacy Policy promises a data-rights contact route, so set up email forwarding (GoDaddy forwarding, or free Cloudflare Email Routing) BEFORE open signup. |
| **6** | **B1 — Trade journal / notes** | Start of the moat. Highest-value item in the original brief. |
| **7** | **B2 — Behavioural analytics** | Names the user's own patterns back to them (disposition effect, over-trading, concentration). Builds on #6's data. |
| **8** | **B3 — Adaptive coaching + progressive unlocks** | Skill-aware teaching; options/margin gated behind understanding, not luck. Depends on #7's signals. |
| **9** | **B5 — Scenario challenges** | "Trade the 2008 crash." Venky's favourite; strong differentiator; runs on existing historical-candle infra. Built here, gated as paid in #11. |
| **10** | **B4 — Super-admin console** | User management, usage + cost dashboards. Needed before/alongside monetization. |
| **11** | **C — Payments** | Stripe, tiers, entitlement enforcement, multiple portfolios, configurable starting capital. Also triggers Vercel Pro (commercial-use licensing) and the legal review. |
| **12** | **D2/D3 — paid data tier + infra hardening** | Only once #2's cache is genuinely saturated, justified by real usage. |
| **13** | **E — Mobile** | After web is proven. |

**Build entitlement checks + usage metering into steps 6–10 as we go** — retrofitting them across a dozen features at step 11 is the expensive path.

## 6b. PRE-LAUNCH CHECKLIST — deferred to the very end (Venky's call, 2026-08-10)

These two are **not code** and are deliberately parked until the build is essentially complete. Venky will have the email set up by then. **Neither may be skipped before opening public signup / charging money.**

1. **`support@mypapertrader.com` must be live.** `legal/privacy.md` and `legal/terms.md` publicly promise this as the contact route for data-rights requests (access/deletion) and general support. A published contact address that bounces is a real compliance gap. Cheapest fix: email forwarding to a personal inbox (check GoDaddy's built-in forwarding first, since DNS already lives there; Cloudflare Email Routing is free but requires moving DNS). **Does NOT affect password reset** — those are sent by Supabase's own mail service, not this address.
2. **Lawyer review of the legal pages.** The drafts (`legal/*.md`) were written for a free, pre-revenue educational product and are explicitly marked as not professionally reviewed. Before charging money or launching widely — especially outside the US — have a qualified attorney review them, with particular attention to the AI-generated-analysis sections, which sit nearest to investment-advice regulation. Jurisdiction is Texas, USA; entity is Venkat Praveen (revisit if an LLC is formed).

## 7. Open decisions

- Monetization timing — **assumed "later"** (build → prove value → charge). Correct if wrong.
- Classroom/organizations — **assumed "not now."** Correct if wrong.
- Free vs. paid feature boundary — needs deciding before Phase C, because it shapes cost architecture.
- Legal review — schedule before any paid public launch.
