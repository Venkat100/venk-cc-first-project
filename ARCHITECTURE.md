# Architecture

This is the technical blueprint for PaperTrader. It's written to be read by both Venky and the Claude Code agent.

---

## 1. Tech stack (CTO's pick)

| Layer | Choice | Why |
|-------|--------|-----|
| **Frontend** | React + Vite + TypeScript, Tailwind CSS, shadcn/ui, Recharts | This is exactly what Lovable generates, so the design hand-off is seamless. TypeScript keeps a data-heavy app safe. |
| **Backend / DB / Auth** | Supabase (Postgres + Auth + Edge Functions) | One-click integration from Lovable. Gives us auth, a real SQL database with row-level security, and serverless functions for calling the market API — no separate server to host. |
| **Market data** | Finnhub (primary) — live quotes + historical candles. Twelve Data as fallback. | Both have free tiers with live *and* historical data. We isolate this behind one module so we can swap providers without touching the app. |
| **Background jobs** | Supabase scheduled functions (pg_cron) | For refreshing prices and snapshotting portfolio value over time. |
| **Hosting** | Lovable's built-in deploy for early demos; Vercel for production frontend; Supabase cloud for backend. | Cheap/free to start, scales fine. |
| **Source control** | GitHub | The repo of record. Lovable can sync directly to GitHub. |

**Guiding principle:** keep the market-data provider behind a single adapter (`lib/marketData/`) so the rest of the app never imports Finnhub directly. If a provider's free tier gets stingy, we change one file.

---

## 2. System overview

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser   │────▶│  React Frontend  │────▶│    Supabase     │
│  (the user) │◀────│  (Lovable build) │◀────│  Auth + Postgres│
└─────────────┘     └──────────────────┘     └────────┬────────┘
                                                       │
                                          Edge Functions (server-side)
                                                       │
                                                       ▼
                                            ┌─────────────────────┐
                                            │  Market Data API     │
                                            │  (Finnhub / 12Data)  │
                                            └─────────────────────┘
```

Why route market data through Edge Functions instead of calling the API from the browser:
- **Hides the API key** — never ships to the client.
- **Caching** — we cache quotes/candles in Postgres so we don't burn the free-tier rate limit.
- **Consistent pricing** — trades execute against a server-fetched price, not a number the client could tamper with.

---

## 3. Data model (Postgres / Supabase)

All tables protected by Row-Level Security so a user can only ever see their own rows.

**`profiles`** — one row per user (extends Supabase `auth.users`)
- `id` (uuid, FK → auth.users)
- `display_name`, `created_at`
- `cash_balance` (numeric) — virtual buying power, starts at 100000

**`holdings`** — current positions (one row per user per symbol)
- `id`, `user_id`
- `symbol`, `quantity` (numeric), `avg_cost` (numeric)
- unique on (`user_id`, `symbol`)

**`transactions`** — immutable ledger of every buy/sell
- `id`, `user_id`, `symbol`
- `side` ('buy' | 'sell'), `quantity`, `price`, `total`
- `order_type` ('market' | 'limit'), `status`, `created_at`

**`watchlist`** — followed symbols
- `id`, `user_id`, `symbol`, `created_at`

**`portfolio_snapshots`** — daily value history (powers the portfolio chart & total return)
- `id`, `user_id`, `total_value`, `cash`, `holdings_value`, `captured_at`

**`instruments`** *(cache)* — basic info per ticker
- `symbol`, `name`, `exchange`, `sector`, `logo_url`, `updated_at`

**`price_cache`** *(cache)* — recent quotes & candles to respect rate limits
- `symbol`, `interval`, `data` (jsonb), `fetched_at`

> Note: cash, holdings, and transactions are the **source of truth** for portfolio value. We never trust a number sent from the browser — the server recomputes.

---

## 4. Core logic rules

**Executing a buy (server-side, in a transaction):**
1. Fetch live price server-side.
2. `cost = price × quantity`. Reject if `cost > cash_balance`.
3. Deduct cash, upsert holding (recompute `avg_cost` as a weighted average), insert a transaction row.

**Executing a sell:**
1. Reject if `quantity > holding.quantity`.
2. Add `price × quantity` to cash, reduce/close the holding, insert a transaction row.

**What-If simulation (read-only, no DB writes):**
1. Fetch the historical close on the chosen date and the latest price.
2. `shares = amount / historical_price`; `value_today = shares × latest_price`.
3. Pull the S&P 500 (SPY) series over the same window for the comparison line.

**Portfolio valuation:**
`total_value = cash_balance + Σ(holding.quantity × current_price)`. A daily job writes a `portfolio_snapshots` row so the value chart and total-return numbers have history.

---

## 5. Proposed folder structure

```
/ (repo root, this folder)
├── README.md / ARCHITECTURE.md / ROADMAP.md / CLAUDE.md   ← planning docs
├── app/                         ← the Lovable React project lives here
│   ├── src/
│   │   ├── components/          ← UI (shadcn-based)
│   │   ├── pages/               ← Dashboard, StockDetail, Simulator, ...
│   │   ├── lib/
│   │   │   ├── supabase/        ← client + typed queries
│   │   │   └── marketData/      ← the provider adapter (the only place Finnhub is referenced)
│   │   ├── hooks/
│   │   └── types/
│   └── ...
└── supabase/
    ├── migrations/              ← SQL for the tables above
    └── functions/               ← edge functions: getQuote, getCandles, executeTrade, runSimulation, snapshotPortfolios
```

---

## 6. Security & integrity checklist

- API keys live only in Supabase secrets, never in the frontend.
- Row-Level Security on every user table.
- Trades execute server-side against server-fetched prices.
- Inputs validated server-side (positive quantities, sufficient funds, owned shares).
- This is clearly labeled a simulation; no real brokerage or money movement.

---

## 7. Open decisions (we'll resolve as we go)

- Finnhub vs. Twelve Data as primary (start Finnhub, validate free-tier limits).
- Whether to support crypto/ETFs in v1 or stocks only (lean: US stocks + a few major ETFs).
- Limit-order handling — fill instantly at limit price if market crosses it, vs. a simple "fill at current if it qualifies." Start simple.
- Real-time push (websockets) vs. polling for live prices. Start with polling on an interval; upgrade later.
