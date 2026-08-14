# Privacy Policy

**Last updated:** 9 August 2026

This policy explains what My PaperTrader (mypapertrader.com), operated by Venkat Praveen, collects about you, why, and what you can do about it. We've written it in plain English on purpose.

**The short version:** we collect the minimum needed to run a trading simulator — your email, what you traded (with virtual money), and basic usage data. We don't sell it, we don't advertise to you, and you can delete all of it yourself at any time.

---

## 1. What we collect

**Account information**
- Email address (required — it's how you sign in and recover your account)
- Display name (optional, if you set one)
- Password — stored only as a secure hash by our authentication provider. We never see or store your actual password.

**Your simulated activity**
- Virtual cash balance, holdings, and option positions
- Your trade history (all simulated)
- Watchlists
- Daily snapshots of your simulated portfolio value
- AI agent configuration and its decision history, if you use it
- Simulated margin activity, if you use it
- Notes and journal entries, if and when you create them

**Technical and usage data**
- Basic analytics: pages visited, features used, and events like signing up or placing your first trade
- Error reports when something breaks, including the page and action involved
- Standard server logs (IP address, browser type, timestamps), used for security and debugging

**What we do NOT collect**
- No real financial account details, bank details, or brokerage credentials — there is nothing to connect
- No payment card details are stored by us; if we introduce payments, our payment processor handles them
- No selling of personal data, ever. No advertising networks.

## 2. Why we use it

- **To run the service** — you can't have a portfolio without us storing your portfolio.
- **To authenticate you** and keep your account secure.
- **To generate AI features you ask for** — for example, sending the ticker and recent public news to our AI provider to produce analysis.
- **To prevent abuse** — rate limits and usage counters stop a single account running up large costs.
- **To fix problems** — error reports tell us the app broke before you have to email us.
- **To understand what's useful** — aggregate usage data tells us which features matter.

We do not use your data to train AI models.

## 3. Who we share it with

We use these third-party services ("subprocessors") to operate My PaperTrader. Each receives only what it needs:

| Service | What it handles | What it receives |
|---|---|---|
| **Supabase** | Database and authentication | Your account and all simulated activity data |
| **Vercel** | Application hosting | Requests, IP address, standard server logs |
| **Anthropic (Claude)** | AI analysis and agent reasoning | Stock tickers, market signals, and public news headlines. **Not your email, name, balances, or personal identifiers.** |
| **Finnhub / Twelve Data** | Market data | Only stock symbols. No user information — these providers never learn who asked. |
| **Sentry** | Error monitoring | Technical error context, which may include your user ID and the page involved. Not passwords or tokens. |
| **Analytics provider** | Product usage | Aggregate/pseudonymous usage events |

If we ever add payments, the payment processor will be added here.

We may also disclose data if legally required, or to protect the rights and safety of our users or ourselves.

## 4. Where your data lives

Our infrastructure providers operate globally, and your data may be processed in countries other than your own — including the United States. We rely on our providers' standard safeguards for international transfers.

## 5. How long we keep it

- **Account data** — until you delete your account.
- **When you delete your account** — your account and all associated data (holdings, trades, options, agent data, margin history, notes, snapshots, watchlists) are permanently deleted. This is a genuine cascading deletion, not a soft flag, and it cannot be undone.
- **Error logs and analytics** — retained for a limited period on a rolling basis and then discarded.
- **Cached market data** — pruned automatically; it contains no personal data anyway.

## 6. Your rights

Regardless of where you live, you can:

- **Access** your data — most of it is visible directly in the app.
- **Correct** it — change your display name, email, or password in Settings.
- **Delete** it — Settings → Delete account. Immediate and permanent.
- **Ask questions** — email us at support@mypapertrader.com.

Depending on your jurisdiction (for example under the UK/EU GDPR or California law), you may also have rights to data portability, restriction of processing, or to object to processing. Contact us and we'll help.

## 7. Cookies and local storage

We use only what's necessary to run the service:

- **Authentication** — to keep you signed in.
- **Preferences** — such as light/dark theme.
- **Analytics** — privacy-respecting measurement of feature usage.

We do not use advertising or cross-site tracking cookies.

## 8. Security

We take security seriously and have designed for it deliberately:

- Every user's data is isolated at the database level, so one account cannot read another's.
- All money-affecting operations run on our servers, never trusted from your browser.
- API keys and secrets are held server-side only and are never sent to your browser.
- Passwords are hashed by our authentication provider; we never see them.

No system is perfectly secure, but if we discover a breach affecting your personal data we will notify you and any relevant authority as required by law.

## 9. Children

My PaperTrader is not intended for anyone under 18, and we do not knowingly collect data from children. If you believe a child has created an account, contact us and we'll remove it.

## 10. Changes to this policy

We may update this policy. Material changes will be communicated in the app or by email. The "last updated" date above always reflects the current version.

## 11. Contact

**support@mypapertrader.com**

---

> **⚠️ Draft status:** Prepared for a free, pre-revenue educational product; **not reviewed by a lawyer.** Before charging money or launching widely — particularly into the EU/UK — have a qualified attorney review this, and revisit the subprocessor table whenever the stack changes.
