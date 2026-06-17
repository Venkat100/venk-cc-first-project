# HANDOFF — Session Continuity Document

> **Purpose of this file:** This is the living memory of the PaperTrader project. If you are a new Claude session (Cowork or Claude Code) picking this up cold, read this file FIRST, then `README.md`, `ARCHITECTURE.md`, and `ROADMAP.md`. It records who we are, what we've decided, what's done, what's next, and every important decision and its reasoning — so no context is ever lost between sessions.
>
> **Maintenance rule:** Claude (acting as CTO in Cowork) updates this file at the end of any meaningful exchange — new decisions, completed work, changed direction, new blockers. Append to the Changelog at the bottom every time. Keep it elaborate. When in doubt, over-document.

**Last updated:** 2026-06-16
**Current phase:** Phase 3 COMPLETE → starting Phase 4 (database & portfolio plumbing). Monorepo live on GitHub `origin/main` at commit `0a48d9f`. Real Supabase email/password auth shipped, app gated behind login, $100k seeded server-side.

**GitHub auth:** Venky's machine is authenticated via `gh` CLI (logged in as Venkat100, `repo` scope) — future pushes work without re-auth.
**Supabase project:** `papertrader` is live. Security: Data API ON, auto-expose-new-tables OFF, automatic RLS ON. `profiles` table + `handle_new_user` trigger applied via SQL Editor (migration `supabase/migrations/0001_init_profiles.sql`). Email confirmation turned OFF for dev testing (turn back ON before launch). URL + publishable key live in `app/.env` (gitignored, never pushed).
**Auth implementation notes:** single Supabase client at `app/src/lib/supabase/client.ts`; `AuthProvider`/`useAuth` at `app/src/lib/auth/auth-context.tsx`; route guard `AuthGate` in `routes/app.tsx` is CLIENT-side on purpose (session lives in browser, not SSR server). DB types must be `type` aliases not `interface` or supabase-js generics collapse to `never`.
**Loose ends:** test user `papertrader-verify+...@example.com` still in Supabase Auth→Users (deletable). Landing page "Try simulator/Explore demo" buttons redirect to login since `/app/*` is gated — see backlog "public simulator preview".

**⚠️ Stack correction:** The Lovable frontend is a **TanStack Start** app (full-stack React with TanStack Router + a built-in server layer), NOT a plain Vite SPA as the docs originally assumed. Docs updated. Implication: backend/server logic could live in TanStack Start server functions OR Supabase Edge Functions — decision deferred to backend phase (leaning TanStack server functions for market data, Supabase for DB/auth/RLS).

---

## 1. The people & the working model

- **Venky** (venkatpraveen1@gmail.com) — product owner / founder. Driving the project, makes final calls. Prefers concise, direct communication. Is not coding much himself by choice — wants the agent to do most of the coding.
- **Claude in Cowork** — acting **CTO + product manager**. Plans architecture, makes technical decisions, and writes precise prompts for Venky to run elsewhere.
- **Claude Code** — the **implementation agent**, connected to this folder (`Paper Trading - Venk` on Venky's desktop). Does the actual coding.
- **Lovable** — AI app builder generating the React frontend design.

**The core workflow loop:**
1. Cowork (CTO) and Venky plan together.
2. Cowork writes a precise, copy-paste-ready prompt.
3. Venky pastes it into **Lovable** (for frontend/design) or **Claude Code** (for implementation).
4. Venky brings the result back (screenshot, error, "it worked," or "this looks thin").
5. We iterate in small, tight loops.

Venky explicitly asked: "be my CTO and my product person."

**Standing communication rule (always follow this):** Venky is a product person, NOT technical. Every time he pastes back output from Claude Code, the CTO (Cowork) must respond in two clearly separated parts:
1. **"What just happened"** — plain English, product perspective. What was built/changed, what it means for the app and the user, any problems or decisions needed, whether we're on track. No technical jargon.
2. **"Your next prompt"** — the fully technical, specific, copy-paste-ready prompt for Claude Code.
Never make Venky parse raw technical output himself.

---

## 2. What we're building (one paragraph)

**PaperTrader** — a full-stack paper-trading web app. Users get $100,000 of virtual money, trade real stock tickers at live market prices (no real money), track a live portfolio with profit/loss, and run **"what if I had invested in this stock back then"** simulations against real historical data. It's a simulation / education tool — no real brokerage, no real money movement. The **What-If Simulator** is the flagship differentiator (most paper-trading apps only trade forward; ours looks backward too).

Full detail in `README.md`.

---

## 3. Decisions locked so far (with reasoning)

| Decision | Choice | Why |
|----------|--------|-----|
| Scope of v1 | Comprehensive full platform (not just a calculator) | Venky wants something "comprehensive" / full-fledged. |
| Data needs | Live **+** historical prices | Venky chose this explicitly. Needs a feed with both. |
| Platform | Web app | CTO pick; most flexible, easy to share/deploy. |
| Venky's involvement | Agent does most coding | Venky's choice; keep prompts explicit and beginner-safe. |
| Frontend stack | React + Vite + TypeScript, Tailwind, shadcn/ui, Recharts | Matches what Lovable generates → seamless hand-off. |
| Backend | **Supabase** (Postgres + Auth + Edge Functions) | One-click from Lovable, no server to host, gives auth + SQL + serverless functions. |
| Market data | **Finnhub** primary, **Twelve Data** fallback | Both free tiers have live + historical. Isolated behind one adapter so we can swap. |
| Source control | GitHub | Repo of record; Lovable can sync to it. |
| Hosting (planned) | Vercel (frontend) + Supabase cloud (backend) | Cheap/free to start. |

**Hard architectural rules (non-negotiable):**
1. Never call the market API from the browser — all market data via Supabase Edge Functions; API key in Supabase secrets only.
2. Never trust client-supplied prices/balances — trades execute server-side against a server-fetched price.
3. Row-Level Security on every user table.
4. Isolate the data provider — only `app/src/lib/marketData/` may import Finnhub/Twelve Data.
5. It's a simulation — no real brokerage, no real money.

Full data model and logic in `ARCHITECTURE.md`.

---

## 4. The plan / phases (summary — full version in ROADMAP.md)

- **Phase 0 — Planning** ✅ done (these docs).
- **Phase 1 — Frontend design in Lovable** 🟡 in progress. Full UI on mock data, all 8 screens.
- **Phase 2 — Repo & GitHub.** Sync Lovable → GitHub, connect Claude Code, add docs.
- **Phase 3 — Auth & accounts.** Supabase auth, `profiles`, seed $100k.
- **Phase 4 — Database & portfolio plumbing.** Real tables + RLS, replace mock data.
- **Phase 5 — Live market data.** marketData adapter + Edge Functions, real prices.
- **Phase 6 — Trading engine.** Server-side buy/sell with validation.
- **Phase 7 — What-If Simulator.** The flagship feature, real history + SPY comparison.
- **Phase 8 — Live tracking & polish.** Snapshots, polling, states, mobile.
- **Phase 9 — Launch.** Deploy, secrets, public repo.

**Open sequencing question (raised, not yet decided):** whether to build the What-If Simulator earlier (it's the hero feature and needs no login) vs. the current order. Awaiting Venky's call.

---

## 5. The 8 frontend screens (what Lovable is building)

1. Landing page (marketing).
2. Auth (login + signup).
3. Dashboard — stat cards (portfolio value, buying power, today's change, total return), big value chart with range toggles, holdings table, watchlist + top movers sidebar.
4. Stock detail — price chart, key stats, buy/sell order panel (market + limit), tabs.
5. **What-If Simulator** — pick stock + past date + amount → value today, charted vs. S&P 500. The hero screen.
6. Markets — searchable/filterable stock list with sparklines.
7. Portfolio / Activity — allocation donut + transaction history.
8. Settings — profile, theme toggle, reset paper account to $100k.

Plus global shell: left sidebar nav, top bar with global search + avatar. Dark mode default. Every user starts with $100,000 virtual cash.

> Note: Lovable often "soft-builds" later screens — nails the first few, stubs the rest. Expect 1–3 follow-up prompts to flesh out thin screens (especially the Simulator). This is normal.

---

## 6. Current state / where we left off

- Planning docs written to the folder: `README.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `CLAUDE.md`, and this `HANDOFF.md`.
- The big Lovable design prompt (all 8 screens, mock data) has been **given to Venky and he has run it in Lovable** — awaiting the result.
- **Immediate next steps:**
  1. Venky reviews the Lovable output; brings back screenshots / gaps.
  2. CTO writes follow-up prompts to fill any thin screens.
  3. Decide the Simulator-first vs. current sequencing question.
  4. Draft the Phase 2 prompt (GitHub + connect Claude Code) — offered, not yet written.

---

## 7. The exact Lovable design prompt we used (for reference / reuse)

> Build a polished, modern paper trading platform called **PaperTrader** — a web app where users practice investing with virtual money and run "what if I had invested" simulations. No real money. Build the full UI with realistic mock data; backend + market-data API connected later.
>
> Design system: clean fintech aesthetic (Robinhood meets Bloomberg-lite), dark mode default + light toggle, green gains / red losses, shadcn/ui + Recharts, Inter font, responsive.
>
> Screens: (1) Landing, (2) Auth login/signup, (3) Dashboard with stat cards + portfolio value chart with 1D/1W/1M/3M/1Y/ALL toggles + holdings table + watchlist/top-movers sidebar, (4) Stock detail with price chart + key stats + buy/sell panel (market & limit) + tabs, (5) What-If Simulator (stock + date + amount → value today, charted vs S&P 500 — make it impressive), (6) Markets searchable list with sparklines, (7) Portfolio/Activity with allocation donut + transaction history, (8) Settings with theme toggle + reset to $100k.
>
> Global: left sidebar nav, top bar with global search + avatar. Every user starts with $100,000 virtual cash. Mock data using AAPL/TSLA/NVDA/MSFT/AMZN/GOOGL with realistic histories. Structure so mock data is easy to swap for real API calls. Prioritize beautiful, cohesive, production-quality design; charts and What-If simulator are the visual highlights.

---

## 8. Changelog

- **2026-06-16 (Phase 4 — DB & portfolio plumbing implemented, build-verified; migration pending)** — Claude Code added the per-user data layer. New migration `supabase/migrations/0002_portfolio_tables.sql`: `holdings` (unique user_id+symbol), `transactions` (append-only ledger — insert+select policies only, NO update/delete), `watchlist` (unique user_id+symbol); all owner-only RLS (select/insert/update/delete as appropriate) + `grant ... to authenticated` + indexes (holdings(user_id), transactions(user_id, created_at desc), watchlist(user_id)). Extended `app/src/lib/supabase/types.ts` with `Holding`/`Transaction`/`WatchlistItem` (type aliases). New `app/src/lib/portfolio/queries.ts` (getHoldings/getTransactions/getWatchlist/add/removeFromWatchlist) via the single client; reads rely on RLS (no manual user_id filter). **Price isolation:** new `app/src/lib/marketData/index.ts` is the ONLY current-price lookup — returns placeholder prices from the mock table, clearly marked as the Phase 5 swap point (`getQuote`/`getQuotes`/`getCurrentPrice`); no data provider imported. Swapped mock→real on Dashboard (holdings table, watchlist sidebar, stat cards; cash from profiles), Portfolio/Activity (holdings detail, allocation donuts, transaction ledger), and Watchlist (interactive add/remove writing to Supabase via react-query mutations + invalidation). Top movers / stock universe / sparklines stay on the mock table (market data = Phase 5). New `app/src/components/DataStates.tsx` (EmptyState/LoadingState/ErrorState); friendly empty states everywhere (no holdings, no activity, empty allocation, empty watchlist). portfolio_snapshots deferred (Phase 8); dashboard portfolio chart still placeholder until then. **Verified:** `tsc --noEmit` clean, `npm run build` clean; live read-path smoke test (authenticated) correctly reaches Supabase and reports the 3 tables not-yet-created (PGRST205). **PENDING (needs Venky):** apply `0002_portfolio_tables.sql` in SQL Editor; then Claude re-runs the live script for the full green run (empty reads + watchlist round-trip + ledger-immutability check). Committed (NOT pushed). Throwaway `app/verify-*.mjs` gitignored. Loose end: 2 more test users in Auth→Users (`papertrader-verify+…`, `pt-phase4+…`).
- **2026-06-16 (Phase 3 — auth implemented, build-verified; migration pending)** — Claude Code implemented Supabase email/password auth in the TanStack Start app. Added `@supabase/supabase-js`; single typed client at `app/src/lib/supabase/client.ts` (+ `types.ts` — note: schema types MUST be `type` aliases, not `interface`, or supabase-js generics collapse to `never`). New `AuthProvider`/`useAuth` context (`app/src/lib/auth/auth-context.tsx`) wired into `__root.tsx`. Client-side route guard in `app/src/routes/app.tsx` (`AuthGate`) — logged-out users redirected to `/auth`; spinner while session resolves (done client-side because the Supabase session lives in the browser, not the SSR server). `auth.tsx` now does real signUp/signIn with friendly error mapping; `TopBar` shows the real user (initials avatar + dropdown with email + Settings + Log out); `settings.tsx` shows real email (read-only) + editable display_name (saved to profiles via RLS update) + Log out, and reads real `cash_balance`. Created `supabase/migrations/0001_init_profiles.sql` (profiles table, owner-only RLS select/update, explicit grants since auto-expose is off, `handle_new_user` trigger seeding $100k on signup) + `supabase/README.md`. Env: `app/.env` holds the real Supabase URL + publishable key (gitignored); `.env.example` documents both. **Verified:** `tsc --noEmit` clean, `npm run build` clean, dev boots, Supabase auth reachable (GoTrue healthy), SSR of `/app/dashboard` renders the gate (no dashboard content leaks to logged-out requests). **PENDING (needs Venky):** apply `0001_init_profiles.sql` in the SQL Editor (profiles table does NOT exist yet — REST returns PGRST205) and decide email-confirmation on/off; then run the live signup→profile($100k)→logout→login check. Committed (NOT pushed) — awaiting review. Mock portfolio/holdings still in place (Phase 4).
- **2026-06-16 (Phase 3 done)** — Supabase email/password auth SHIPPED and pushed (`origin/main` @ `0a48d9f`; commits `0091e7f` cleanup + `0a48d9f` auth). `.claude/settings.local.json` untracked. Built: single Supabase client, AuthProvider/useAuth, client-side AuthGate route guard, real signup/login/logout, TopBar avatar + Settings wired to `profiles`. `profiles` table + `handle_new_user` $100k trigger applied in dashboard; email confirmation off for dev. Verified live end-to-end: signup → profile row w/ cash_balance 100000 → logout → login. Secrets confirmed NOT on remote (only `.env.example`). Fixed a supabase-js generics gotcha (use `type` not `interface`). Mock portfolio data still in place (Phase 4 target). Next: Phase 4 DB plumbing (holdings/transactions/watchlist + RLS, swap mock reads for real Supabase).
- **2026-06-16 (Phase 2 done)** — Monorepo pushed to GitHub. Docs commit `c531d54` ("docs: correct stack to TanStack Start..."), merged `chore/import-frontend` → `main`, set up `gh` CLI auth (Venkat100), pushed `origin/main`, deleted the import branch. Verified `app/` + 5 planning docs + root `.gitignore` present on remote. Noted `.claude/settings.local.json` leaked to remote (to untrack next commit). Started Phase 3 (Supabase auth): gave Venky the prompt; needs Supabase Project URL + anon key. Supabase security settings chosen: Data API on, auto-expose off, automatic RLS on.
- **2026-06-16 (latest)** — Frontend import DONE by Claude Code. Connected the local `Paper Trading - Venk` folder to GitHub remote `venk-cc-first-project` (it was previously a plain folder, not a git repo — chose "git init + add remote"). Imported Lovable frontend into `app/`; it builds cleanly and boots on :8080. Committed on branch `chore/import-frontend`, NOT pushed (awaiting Venky's review). **Discovery: frontend is TanStack Start, not a plain Vite SPA** — updated ARCHITECTURE.md, CLAUDE.md, and this file. Next: review → merge branch to main → push → then Phase 3 (Supabase auth).
- **2026-06-16 (later)** — **Repo strategy decided: MONOREPO.** Single repo `venk-cc-first-project` (https://github.com/Venkat100/venk-cc-first-project) is the source of truth. Lovable frontend lives at `https://github.com/Venkat100/virtual-stratosphere-lab.git` and is being imported into the monorepo under `app/` (copy files in, not git-subtree — scaffold history has little value). **Important consequence:** once imported, the Lovable→virtual-stratosphere-lab sync is effectively dead; all further edits happen via Claude Code, which is now the source of truth. Venky accepted this trade (design considered essentially done in Lovable). Gave Venky a Claude Code prompt to do the import into `app/`, verify the build, commit (no push until reviewed). Backend (`supabase/`) and root planning docs stay at root.
- **2026-06-16** — Project kicked off. Clarified scope (comprehensive, live+historical, web app, agent-does-coding). Chose stack (React/Vite/Tailwind/shadcn via Lovable + Supabase + Finnhub). Wrote the full Lovable design prompt covering all 8 screens; Venky ran it in Lovable. Created planning docs (README, ARCHITECTURE, ROADMAP, CLAUDE.md). Created this HANDOFF.md and committed to maintaining it every session. Open items: Simulator sequencing decision; Phase 2 prompt to be drafted.
