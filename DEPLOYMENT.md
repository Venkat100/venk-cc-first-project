# DEPLOYMENT — PaperTrader (Vercel + Supabase)

Launch runbook for a **soft launch** on a free Vercel URL. Repo stays **private**.
Vercel hosts the frontend (TanStack Start / Nitro) **and** the daily snapshot cron.
Supabase (already live) stays the database + auth + RLS layer.

> **No secret values live in this repo.** The real values are in Venky's local
> `app/.env` (gitignored). Set them in the Vercel dashboard — never commit them.

---

## 0. How the build targets Vercel (already configured)

- `app/vite.config.ts` pins Nitro's **`vercel`** preset (`nitro: { preset: "vercel" }`),
  so `npm run build` emits **`app/.vercel/output/`** (Vercel Build Output API v3).
  Vercel uses that output directly — server functions, SSR, and the
  `/api/cron/snapshot` endpoint all run as Vercel functions.
- **`vercel.json` lives in `app/`, not the repo root.** This is intentional:
  with the Root Directory set to `app/` (step 1), Vercel reads `vercel.json`
  **from the Root Directory**. A repo-root `vercel.json` would be ignored and
  the cron would silently never register.

---

## 1. Connect the repo to Vercel  ⚠️ set Root Directory to `app/`

1. Vercel → **Add New… → Project** → import the GitHub repo
   `Venkat100/venk-cc-first-project` (authorize the GitHub app if prompted; repo
   can stay private).
2. In **Configure Project**, set **Root Directory = `app/`**.
   - 🔴 **This is the #1 gotcha.** The frontend lives in `app/` in this monorepo.
     If Root Directory is left at the repo root, the build, the env vars, and
     `vercel.json` (the cron) all look in the wrong place and the deploy breaks.
3. **Framework Preset:** let Vercel auto-detect. Because the build emits
   `.vercel/output`, Vercel uses it directly. Leave **Build Command**
   (`npm run build`), **Install Command** (`npm install`), and **Output
   Directory** at their defaults — do **not** override the output directory.
4. Don't deploy yet — set the environment variables first (step 2).

---

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

Add each for the **Production** (and Preview, if you want preview deploys) env.
Copy the values from your local `app/.env`.

| Name | Scope | Notes |
|------|-------|-------|
| `VITE_SUPABASE_URL` | **Public** | Supabase project URL. `VITE_` ⇒ shipped to the browser (fine). |
| `VITE_SUPABASE_ANON_KEY` | **Public** | Supabase publishable/anon key. Public by design. |
| `FINNHUB_API_KEY` | **Server-only** | Live quotes/search/profile. **No `VITE_` prefix.** |
| `TWELVEDATA_API_KEY` | **Server-only** | Historical candles/series. **No `VITE_` prefix.** |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only** | Bypasses RLS — used by trade + snapshot writers. **Never public.** |
| `CRON_SECRET` | **Server-only** | Protects `/api/cron/snapshot`. See step 4. |

- Only the two `VITE_`-prefixed vars are exposed to the browser. The other four
  must **not** have a `VITE_` prefix, so they stay server-only.
- Values are in `app/.env` locally. They are **not** in this repo (gitignored).

---

## 3. Supabase — production config

1. **Auth → URL Configuration:**
   - **Site URL:** your Vercel production URL, e.g. `https://<project>.vercel.app`.
   - **Redirect URLs:** add `https://<project>.vercel.app/**` (and any preview URL
     pattern if using preview deploys). This lets email-confirmation / magic links
     redirect back to the deployed app.
2. **Auth → Providers → Email → turn "Confirm email" back ON.**
   - It was OFF for dev testing. For a public launch, new signups should confirm
     their email. (The app already handles the "check your email to confirm"
     state after signup.)
3. (Sanity) the three migrations are already applied in prod:
   `0001_init_profiles`, `0002_portfolio_tables`, `0003_execute_trade`,
   `0004_portfolio_snapshots`.

---

## 4. The daily cron — how it's wired & how to verify

- `app/vercel.json` declares:
  ```json
  { "crons": [{ "path": "/api/cron/snapshot", "schedule": "0 22 * * *" }] }
  ```
  → runs daily at **22:00 UTC** (after the US market close).
- **Auth:** when a **`CRON_SECRET`** env var is set on the Vercel project, Vercel
  automatically sends `Authorization: Bearer <CRON_SECRET>` with every cron
  request. Our endpoint (`app/src/lib/snapshots/endpoint.server.ts`) checks
  exactly that header — so **no code change is needed**; just set `CRON_SECRET`
  in Vercel (step 2).
- **Free (Hobby) plan note:** Hobby allows cron jobs but only **daily** schedules,
  triggered within a window of the stated time. `0 22 * * *` is daily → fine.

**Confirm the cron registered:** after deploy, Vercel → Project → **Settings →
Cron Jobs** lists `/api/cron/snapshot @ 0 22 * * *`. (You can also click **Run**
there to trigger it once.)

**Manually test in prod** (replace with your URL + the real secret):
```bash
# Should succeed (200) with a JSON summary:
curl -i -H "Authorization: Bearer <CRON_SECRET>" \
  https://<project>.vercel.app/api/cron/snapshot

# Should be rejected (401):
curl -i https://<project>.vercel.app/api/cron/snapshot
```
A 200 returns `{"ok":true,"summary":{...snapshotsWritten...}}`. A request with no
/ wrong token returns `401 {"ok":false,"error":"Unauthorized."}`.

---

## 5. Final QA checklist (on the live URL)

- [ ] Landing page loads; **"Try the simulator"** → `/simulator` works **logged out**.
- [ ] Run a What-If simulation (e.g. $5k NVDA 2019) → result + SPY comparison + chart render.
- [ ] **Sign up** a new account → receive + click the **confirmation email** → land logged in.
- [ ] **Log out**, then **log in** again → dashboard loads.
- [ ] **Markets** shows live prices (8 symbols, no rate-limit error).
- [ ] Open a stock → **place a paper trade (buy)** → success toast; buying power + holdings update.
- [ ] **Dashboard value chart** renders (origin → today) and the **1W/1M/3M/1Y/ALL** toggles work.
- [ ] **Today's change** and **Total return** show sensible, consistent numbers.
- [ ] Trigger `/api/cron/snapshot` (step 4) → a snapshot row is written; the chart gains today's point.
- [ ] Confirm no secrets in the client: open devtools → Network/Sources, search for the
      Finnhub/Twelve Data/service-role/cron values → should find **none** (only `VITE_` vars).

---

## Notes / known follow-ups
- Historical-value **backfill** (reconstructing past portfolio value from the
  ledger + historical prices) is a TODO — until then the value chart starts from
  the account-creation $100k origin and builds forward daily.
- Test users created during development still exist in **Auth → Users** — delete
  them before/around launch for a clean list.
- Cosmetic: the simulator headline start-date can render one day early in
  timezones behind UTC (dollar figures unaffected).
