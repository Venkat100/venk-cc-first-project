# PaperTrader

**Practice investing with virtual money — and let an AI manage a portfolio for you.**

PaperTrader is a full-stack paper-trading platform with an autonomous AI portfolio agent. Users get a virtual cash balance, trade real stocks and ETFs at live market prices, track a portfolio with live profit/loss, run historical "what-if" simulations, and can hand a slice of their virtual cash to an AI agent that builds and manages a portfolio on its own.

It is an **educational simulation** — no real money, no brokerage connection, nothing executed against real markets. All cash and holdings are virtual.

🔗 **Live:** https://venk-cc-first-project.vercel.app

---

## Features

**Trading & portfolio**
- **Virtual portfolio** — every user starts with $100,000 in virtual cash and trades real tickers at live prices.
- **Real-time trading** — buy/sell validated server-side against buying power and holdings; weighted-average cost basis; immutable transaction ledger.
- **Live tracking** — portfolio value, day change, and total return against near-real-time quotes, with a value-history chart.
- **Markets & watchlists** — search and follow any stock or ETF with live quotes and sparkline previews.

**What-If Simulator**
- Pick a stock, a past date, and an amount, and see exactly what it would be worth today — charted against the S&P 500. Look *backward*: "if I'd put $5,000 into NVDA in 2019, I'd have $X today."

**AI Portfolio Agent**
- A separate sub-portfolio you fund from your virtual cash, managed by an AI agent — a hybrid of transparent quant scoring and Claude's reading of recent market news.
- **Risk levels** — conservative, balanced, or aggressive, each with its own diversification, position-size, and cash-buffer guardrails.
- **Two modes** — *autonomous* (the agent trades within guardrails) or *approve first* (it proposes changes for you to approve or reject).
- **Trailing-stop protection** — a volatility-sized, anti-whipsaw trailing stop on every position that ratchets up and protectively sells on a real drawdown.
- **Gentle daily rebalancing** — a drift band avoids needless churn, prefers deploying cash over selling winners, and won't immediately re-buy a name it just stop-sold.
- **Performance dashboard** — holdings with live P&L and stop levels, a plain-English decision log, and day-over-day growth benchmarked against the S&P 500.
- **Autopilot** — the agent runs itself: a daily "thinker" rebalance and an intraday risk "watchdog."

---

## Tech stack

- **Frontend:** React + [TanStack Start](https://tanstack.com/start) (full-stack React with a server layer) + TypeScript, Tailwind CSS, shadcn/ui, Recharts.
- **Backend:** [Supabase](https://supabase.com) — Postgres, Auth, and Row-Level Security on every user table. Trade execution and portfolio math run server-side in atomic SQL functions.
- **Market data:** [Finnhub](https://finnhub.io) (live quotes, search, company profile, fundamentals) + [Twelve Data](https://twelvedata.com) (historical candles for charts and the simulator), accessed only through a server-side data layer with rate-limiting and a shared cache.
- **AI:** [Claude](https://www.anthropic.com) via the Anthropic API for the agent's news/sentiment reasoning.
- **Deployment:** [Vercel](https://vercel.com) (app + daily cron jobs), with a GitHub Actions schedule driving the intraday watchdog.

All market-data and AI keys are server-only (never shipped to the browser), prices and balances are never trusted from the client, and every user table is protected by Row-Level Security.

---

## Not financial advice

PaperTrader is an educational simulation. The AI agent trades virtual money only and can lose it; nothing here is financial advice, and no agent can guarantee gains. The value is intelligent, transparent, risk-managed practice — not a real brokerage.

---

## Project docs

| File | What it covers |
|------|----------------|
| `README.md` | This overview |
| `ARCHITECTURE.md` | Tech stack, system design, data model, API contracts, folder structure |
| `ROADMAP.md` | Phased build plan |
| `HANDOFF.md` | Living project memory — decisions, state, and what's next |
