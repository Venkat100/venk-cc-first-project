# PaperTrader

Practice investing with virtual money — and answer the question *"What if I had invested in this stock back then?"*

PaperTrader is a full-stack paper-trading platform. Users get a virtual cash balance, buy and sell real stocks at live market prices (no real money involved), track a portfolio with live profit/loss, and run historical "what-if" simulations against real market data.

---

## What it does

- **Virtual portfolio** — every user starts with $100,000 in virtual cash and trades real tickers at live prices.
- **Buy / sell** — market and limit orders, validated against buying power and holdings.
- **Live tracking** — portfolio value, day change, and total return update against near-real-time quotes.
- **What-If Simulator** *(the flagship feature)* — pick a stock, a past date, and an amount; see exactly what it would be worth today, charted against the S&P 500.
- **Markets & watchlists** — search, browse, and follow stocks with sparkline previews.
- **Activity history** — full transaction log and allocation breakdowns.

## The differentiator

Most paper-trading apps only let you trade forward from today. The **What-If Simulator** lets users look *backward* — "if I'd put $5,000 into NVDA in 2019, I'd have $X today." This is the feature we lead with in design, polish, and marketing.

## No real money, ever

This is a simulation and education tool. No brokerage connection, no real funds, no trade execution against real markets. All cash and holdings are virtual.

---

## Documents in this folder

| File | What it covers |
|------|----------------|
| `README.md` | This overview |
| `ARCHITECTURE.md` | Tech stack, system design, data model, API contracts, folder structure |
| `ROADMAP.md` | Phased build plan and the prompt-by-prompt workflow we follow |
| `CLAUDE.md` | Persistent context for the Claude Code agent working in this repo |

## How we work

Venky is product owner. Claude (Cowork) is acting CTO + product. Claude Code is the implementation agent connected to this folder. The loop: **plan → CTO writes a precise prompt → Venky runs it in Claude Code / Lovable → results come back → iterate.**

## Status

Phase 0 — planning. Frontend design is being generated in Lovable on mock data. Backend and live data come next. See `ROADMAP.md`.
