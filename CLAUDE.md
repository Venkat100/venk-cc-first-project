# CLAUDE.md — Context for Claude Code

You are the implementation agent for **PaperTrader**, a full-stack paper-trading web app. **Read `HANDOFF.md` FIRST** (it's the living memory of the project — current state, decisions, where we left off), then `README.md`, `ARCHITECTURE.md`, and `ROADMAP.md` before starting work. This file is the quick-reference.

## What this project is
A paper-trading platform: users trade real tickers at live prices with $100,000 of virtual money, track a live portfolio, and run "what-if I had invested back then" simulations. No real money, no real brokerage — it's a simulation/education tool.

## Stack
- **Frontend:** React + **TanStack Start** + TypeScript, Tailwind CSS, shadcn/ui, Recharts. (Generated in Lovable; lives in `app/`.) NOTE: it's TanStack Start (full-stack React w/ a server layer), NOT a plain Vite SPA. It has its own server functions, which may host backend logic instead of/alongside Supabase Edge Functions — TBD at backend phase.
- **Backend:** Supabase — Postgres, Auth, Edge Functions. Migrations in `supabase/migrations/`, functions in `supabase/functions/`.
- **Market data:** **Twelve Data (primary — current key in use)**, Finnhub (fallback, hook present but thin), accessed ONLY through `app/src/lib/marketData/`. Free tier ~8 credits/min → keep the live universe small + TTL-cached.

## Non-negotiable rules
1. **Never call the market API from the browser.** All market data goes through a SERVER-SIDE layer — **TanStack Start server functions** (decided 2026-06-16; chosen over Supabase Edge Functions for simplicity since the frontend is TanStack Start with its own server). The market-data API key lives in a server-only env var (NOT a `VITE_`-prefixed/public var), never in the repo, never shipped to the client.
2. **Never trust client-supplied prices or balances.** Trades execute server-side against a server-fetched price. The server recomputes portfolio value.
3. **Row-Level Security on every user table** — users see only their own rows.
4. **Isolate the data provider.** Nothing outside `lib/marketData/` may import Finnhub/Twelve Data directly.
5. **It's a simulation.** No code that connects to a real brokerage or moves real money.

## Data model (see ARCHITECTURE.md §3 for full detail)
`profiles` (cash_balance starts 100000), `holdings` (qty + avg_cost per symbol), `transactions` (immutable ledger), `watchlist`, `portfolio_snapshots` (daily value history), plus `instruments` and `price_cache` caches.

## Trading logic
- **Buy:** reject if cost > cash; deduct cash; upsert holding with weighted-average avg_cost; log transaction.
- **Sell:** reject if qty > holding; add proceeds to cash; reduce/close holding; log transaction.
- **Portfolio value:** `cash + Σ(qty × current_price)`.
- **What-If:** `shares = amount / price_on_date`; `value_today = shares × latest_price`; compare vs. SPY.

## Working style
- We build in phases (see `ROADMAP.md`). Stay within the current phase unless told otherwise.
- Prefer small, verifiable changes. After meaningful changes, ensure the app builds and runs.
- Keep secrets out of the repo (`.env` in `.gitignore`, use `.env.example`).
- Write TypeScript types for all data shapes; no untyped market data flowing through the app.

## Current phase
See the top of `ROADMAP.md`. As of now: Phase 1 (frontend design in Lovable) → heading into Phase 2 (GitHub) and Phase 3 (auth).
