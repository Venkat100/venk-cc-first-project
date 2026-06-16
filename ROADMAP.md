# Roadmap

The build is split into phases. Each phase ends with something working that you can see and react to. We don't move on until the current phase feels right.

The loop for every step: **CTO (Cowork) writes a precise prompt → Venky runs it in Lovable or Claude Code → results come back → we iterate.**

---

## Phase 0 — Planning ✅ (we are here)
- Vision, scope, architecture, data model — done (these docs).
- Stack chosen: React/Vite + Tailwind + shadcn (Lovable), Supabase backend, Finnhub data.

## Phase 1 — Frontend design (in progress, in Lovable)
- Full UI on mock data: all 8 screens + global shell.
- **Goal:** a clickable, beautiful product to react to.
- **Done when:** every screen exists and looks production-quality. Expect 1–3 follow-up prompts to fill thin screens (esp. the Simulator).

## Phase 2 — Repo & GitHub
- Sync the Lovable project to GitHub, connect Claude Code to this folder.
- Add the planning docs + `CLAUDE.md` to the repo.
- **Done when:** code is in version control and Claude Code can build/run it locally.

## Phase 3 — Auth & accounts (Supabase)
- Connect Supabase, enable email/password auth.
- Create `profiles`; every new user seeded with $100,000 virtual cash.
- Gate the app behind login; wire the real user into the UI.
- **Done when:** you can sign up, log in, and see your own (still mostly mock) dashboard.

## Phase 4 — Database & portfolio plumbing
- Create the tables from `ARCHITECTURE.md` (holdings, transactions, watchlist, snapshots) with Row-Level Security.
- Replace mock holdings/activity/watchlist with real reads from Supabase.
- **Done when:** the portfolio and activity pages reflect real database rows.

## Phase 5 — Live market data
- Build the `marketData` adapter + Edge Functions: `getQuote`, `getCandles`.
- Wire real prices into Markets, Stock Detail, Dashboard, with caching to respect rate limits.
- **Done when:** charts and prices show real, current market data.

## Phase 6 — Trading engine
- `executeTrade` Edge Function: server-side buy/sell with all the validation rules.
- Hook up the buy/sell panel; balances and holdings update for real.
- **Done when:** you can place a paper trade and watch your portfolio change correctly.

## Phase 7 — What-If Simulator (the flagship)
- `runSimulation` Edge Function: historical price → value today, with SPY comparison.
- Polish the visuals — this is the hero feature.
- **Done when:** the simulator gives accurate, impressive results on real history.

## Phase 8 — Live tracking & polish
- Daily `snapshotPortfolios` job for the value chart and total return.
- Price polling/refresh, day-change math, empty/loading/error states, mobile pass.
- **Done when:** the app feels alive and complete.

## Phase 9 — Launch
- Deploy frontend (Vercel) + Supabase prod, environment secrets, final QA.
- Polished README, screenshots, public GitHub repo.
- **Done when:** it's live and shareable.

---

## Backlog (post-v1 ideas)
Leaderboards, achievements, multiple watchlists, dividends, options, crypto, social/sharing of simulations, news feed per stock, CSV export, mobile app.

---

## How to bring work back to me

When a prompt finishes, send me any of: a screenshot, the error text, "it worked," or "this screen looks thin." I'll either write the next prompt or a fix-it prompt. Small, tight loops beat big leaps.
