# Mobile Responsive Audit

**Date:** 2026-08-17 · **Scope:** every authenticated route plus landing, auth, and legal pages, at 375px, 390px, and 430px. **Method:** live browser testing, signed in as a throwaway seeded account (`mobile-audit-*@example.org`, real holdings in AAPL/NVDA/VOO, watchlist TSLA/MSFT, seeded via real trades through the actual UI — not synthetic data), screenshotted at each width, cross-checked with `document.documentElement.scrollWidth` vs `window.innerWidth` for the hard-fail overflow test on every page. Admin console pages (`/app/admin/*`) were reviewed via source only, not live-screenshotted — `is_admin` has **no client or service-role write path by design** (confirmed in `0026_admin_console.sql` and `verify-admin-live.ts`; only set manually via direct SQL), so there is no test-safe way to grant admin on a throwaway account, and using the real admin account was out of scope. Their JSX was checked for the same reflow anti-pattern found on Stock Detail and for un-wrapped tables; neither was found (see "Admin pages" below).

**Why 375 / 390 / 430 render identically almost everywhere:** Tailwind's first responsive breakpoint in this codebase is `sm: 640px`. No component uses a custom breakpoint between 375–430px, and nothing in the app is a fixed pixel width in that range (confirmed by grep for hard-coded `px` widths and by the fact that zero pages showed horizontal overflow even at the narrowest, 375px — the tightest case). So a bug that reproduces at 375 reproduces identically at 390 and 430, and a page clean at 375 was clean at 390/430 too in every case checked. Screenshots below are mostly at 375px (the worst case) with 430px spot-checks on the pages that had findings, to confirm this holds rather than assuming it.

---

## Summary

| # | Finding | Tier | Status |
|---|---|---|---|
| 1 | Stock Detail header: 2-column grid never stacks at mobile widths (triggering bug) | (a) broken | **Fixed** |
| 2 | Portfolio allocation donut chart: intermittent blank render on mount (Recharts race) | (a) broken | **Fixed** |
| 3 | `formatCalendarDate` double-timestamp bug → "Invalid Date" on Simulator + Stock Detail price chart | (a) broken | **Fixed** |
| 4 | Icon-button tap targets under 44×44px, app-wide | (b) visible/usable | **Fixed** (2026-08-17) |
| 5 | What-If Simulator chart: linear Y-axis hides early growth for extreme-return stocks | (c) polish | Reported, not fixed |
| 6 | Watchlist table "ACTIONS" header sits tight against the card edge at 375px | (c) polish | Reported, not fixed |

Zero horizontal overflow found on any route at any of the three widths, before or after fixes.

---

## 1. Triggering bug — Stock Detail header (tier a, FIXED)

**Route:** `/app/stock/$symbol` · **Widths:** 375, 390, 430 (identical) · `app.stock.$symbol.tsx:133`

**Symptom (as reported):** at mobile width, the sector chip ("SEMICONDUCTORS") sat above the company name but horizontally offset, the name/tag stack was cramped against the price block, and the symbol itself truncated ("NV…"); price, day-change, and "Market closed" collided with the identity block.

**Root cause:** the header container's base (mobile) class was a **2-column CSS grid** —
```
grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:justify-between
```
— which forces the identity block and the price block into two side-by-side columns at ANY width below `sm`, never stacking. The `sm:flex sm:flex-wrap` override (a layout that CAN wrap/stack if it doesn't fit) only applied at 640px and up — backwards from what mobile needed. This squeezed both blocks into ~half-width columns at 375px, which is exactly what produced the truncation and collision.

**Fix:** swapped the base/override direction — `flex flex-col` (stacked, full width) as the base, `sm:flex-row sm:flex-wrap sm:justify-between` from 640px up. Also flipped the price block from a hardcoded `text-right` to `text-left sm:text-right` (so numbers read naturally left-aligned when stacked, right-aligned when in a row next to identity), and `MarketStatusBadge`'s `justify-end` to `justify-start sm:justify-end` for the same reason.

**Before / after, 375px:**

| Before | After |
|---|---|
| Symbol truncated to "NV…", chip misaligned, price block cramped into the same row | Logo, "NVDA" + "SEMICONDUCTORS" chip, "NVIDIA Corp" stacked full-width; price/change/market-status block below, also full-width, no collision |

Desktop (1280px) row layout confirmed unchanged — identity left, price block right-aligned, exactly as before.

---

## 2. Portfolio allocation donut chart — intermittent blank render (tier a, FIXED)

**Route:** `/app/portfolio` · **Not mobile-specific** — reproduces at any width, including desktop — but directly affects mobile users the same as anyone else, and was caught during this sweep. `app.portfolio.tsx:312` (`DonutCard`).

**Symptom:** both "Allocation by stock" and "Allocation by sector" donut charts sometimes rendered as an empty ring — correct legend, correct card, zero visible pie slices — on a genuinely fresh page load. Confirmed via `svg.recharts-surface path` count: 0 paths on the broken renders, vs. 3 (the two arc paths + tooltip cursor) when working. Reproduced on ~half of fresh navigations, at 375px and at 1280px, both immediately after `navigate()` and after waiting up to 4.5s — ruling out a simple loading-race that resolves with time.

**Root cause:** a known class of Recharts + `ResponsiveContainer` + `Pie` timing race: on some mounts, the animation state machine computes its "from" geometry against a stale/zero container measurement and never corrects itself once real data/size are available, leaving the `<Pie>` with zero rendered `<path>` sectors even though the SVG itself is correctly sized and the data is valid (confirmed real, non-degenerate arc geometry on the "working" renders with the identical data).

**Fix:** `isAnimationActive={false}` on the `<Pie>` — removes the entire animation-state-machine dependency on mount timing, so the chart always renders synchronously from final data. Verified with 3 consecutive fresh `navigate()` reloads post-fix, all 3 correct (paths present every time), vs. intermittent failure pre-fix.

**Before / after, 375px:** before — two empty grey rings with correct legends beneath them; after — correct green/blue/orange arcs on both charts, confirmed 3/3 fresh loads.

---

## 3. `formatCalendarDate` double-timestamp bug — "Invalid Date" (tier a, FIXED)

**Routes:** `/app/simulator` (X-axis tick labels) and `/app/stock/$symbol` price chart tooltip, any range other than 1D · **Not mobile-specific**, found during this sweep while checking the Simulator's chart at 375px.

**Symptom:** the What-If Simulator's results chart showed **no visible growth line** and its X-axis read "Invalid Date" / "Invalid Date" instead of real dates. The Stock Detail page's price-chart tooltip (1W/1M/3M/1Y/ALL ranges) showed the same "Invalid Date" as its label when hovered.

**Root cause — a regression from this session's earlier `formatCalendarDate` utility (`lib/format/datetime.ts`)**: the function was built to accept a bare `YYYY-MM-DD` Postgres `date` string and render it by appending `T00:00:00Z`. Two call sites — `SimulatorPanel.tsx`'s XAxis/tooltip formatters and `LivePriceChart.tsx`'s tooltip label — pass it `SimPoint.t` / `Candle.t`, which are built via `new Date(v.datetime).toISOString()` in `provider.server.ts` — a **full ISO instant string**, not a bare date. Concatenating `T00:00:00Z` onto an already-complete ISO string (`"2019-06-03T00:00:00.000Z"` → `"...ZT00:00:00Z"`) produces an invalid date string, which `toLocaleDateString` silently renders as the literal text "Invalid Date" — exactly matching what was on screen. (The "missing line" on the Simulator chart was a red herring, not part of this bug — the line/area paths were real and correctly positioned; NVDA's ~6,632% return over the period is simply flat-near-zero against a linear $0–$340k axis for most of the timeline, a chart-readability characteristic, not a defect — see finding 5.)

Checked every other `formatCalendarDate` call site added in the prior session for the same mismatch: `PortfolioValueChart` (`portfolio_snapshots.captured_at`, a genuine Postgres `date` column) and `ScenarioChart`/`app.scenarios.*.tsx` (`sim_date`, also a genuine `date` column) were confirmed correct — only the two candle-derived (`Candle.t`/`SimPoint.t`) call sites were affected.

**Fix, at the shared layer** (not per call site, matching this session's established convention): `formatCalendarDate` now does `dateOnly.slice(0, 10)` before appending the time suffix. A bare `"2026-09-19"` slices to itself (no-op, zero behavior change for the callers that were already correct); a full ISO string `"2019-06-03T00:00:00.000Z"` slices to `"2019-06-03"`, fixing the bug. Updated the function's doc comment to state explicitly that both input shapes are accepted and why that's safe (a full-ISO daily-candle timestamp IS the calendar day, just serialized differently — not a second real time value colliding with the first).

**Before / after (live-verified):**
- Simulator X-axis: before — "Invalid Date" / "Invalid Date"; after — "Jul 21" / "Dec 23" / "Aug 26" (real ticks).
- Stock Detail 1Y tooltip: before — "Invalid Date"; after — "Feb 18, 2026" (verified against a real hovered data point).

---

## 4. Icon-button tap targets under 44×44px (tier b — FIXED 2026-08-17)

**Routes:** app-wide (TopBar hamburger, theme toggle; Markets/Watchlist star-toggle buttons; the watchlist row's "X" remove button; the avatar/profile trigger; the mobile-nav overlay's close button; `MarketBriefCard`'s carousel arrows; the search box's "Clear" button). Originally measured via `getBoundingClientRect()` on Markets at 375px:

| Element | Before | After |
|---|---|---|
| Hamburger menu | 31×36px | **44×44px** |
| Theme toggle | 31×36px | **44×44px** |
| Avatar/profile dropdown trigger | ~40×40px | **44×44px** |
| Mobile-nav overlay close button | 32×32px | **44×44px** |
| Add/Remove-watchlist star (`WatchlistStar`, per row) | 32×32px | **44×44px** |
| Watchlist row remove button (mobile) | 36×36px | **44×44px** |
| `MarketBriefCard` prev/next arrows | 28×28px visible | 28×28px visible, **~44×44px effective tap area** (pseudo-element expansion — see below) |
| Search box "Clear" button | ~30×20px, no explicit target | 30×32px visible, **~46×56px effective tap area** (same technique) |

All were genuinely tappable before this fix — this was never a broken/unusable finding — but all fell under the commonly-cited 44×44px minimum comfortable touch target, and per the follow-up instruction ("these are primary navigation on a phone; that's a usability failure, not polish"), fixed now rather than deferred further.

**Approach — two techniques, chosen per context, not one blanket rule:**
1. **Direct box growth** (hamburger, theme toggle, avatar trigger, mobile-nav close, `WatchlistStar`, watchlist remove button): the button/hit-area box itself grew to 44×44 (or 44px on the constrained axis for the desktop-preserving watchlist remove button), while every icon GLYPH inside stayed exactly the same size (`h-4 w-4`/`h-5 w-5`/the star's own `size` prop) — safe here because each of these sits in a row with genuine breathing room (a 56px-tall header, a 69px-tall table row, a full-height nav panel), confirmed by inspection and then by screenshot, not assumed.
2. **Invisible pseudo-element expansion** (`MarketBriefCard`'s arrows, the search "Clear" button): where growing the visible box risked genuinely crowding a tight row (arrows next to a card title and an "n / N" counter; "Clear" inline with a compact search field), the visible chrome was left untouched and a `before:` pseudo-element with a negative `inset` expands the actual clickable/tappable region outward instead — a standard, WCAG 2.5.5/2.5.8-aligned technique (the pseudo-element's painted area still dispatches clicks to the real button; nothing about the surrounding layout changes since absolutely-positioned pseudo-elements don't participate in document flow). Confirmed via computed style, not just class inspection: the "Clear" button's `::before` resolved to `position: absolute; content: ""; inset: -12px -8px`, expanding a 30×32 visible box to a ~46×56 effective target.

**A real bug this fix surfaced, not a hypothetical**: growing the TopBar's three buttons to `h-11 w-11` initially had no effect on their rendered WIDTH — the header's flex row has the search box at `flex-1`, and the buttons (with no `shrink-0`) were being silently compressed back down by flexbox's default `flex-shrink:1` whenever the row's content didn't fit. Adding `shrink-0` fixed the width, which then exposed a genuine 14px overflow of the header's own box — traced to the search box's wrapper having no `min-w-0`, so its `flex-1` couldn't shrink past the `<input>`'s own browser-intrinsic content minimum (a classic flexbox-plus-form-element gotcha). Fixed with `min-w-0` on the wrapper. Confirmed `header.scrollWidth === header.clientWidth` (no overflow) at 375, 430, and 1280px after both fixes, and confirmed desktop is visually unaffected (screenshotted).

## 5. What-If Simulator: linear-scale chart hides early growth for extreme-return stocks (tier c)

**Route:** `/app/simulator`, `/app/simulator` (public). Not a bug — a legitimate chart-design limitation, discovered while diagnosing finding 3. For a stock like NVDA with a multi-thousand-percent return over the simulated window, the $0–peak linear Y-axis makes the early years' dollar values (a few thousand dollars, vs. a $300k+ peak) visually indistinguishable from zero — the growth curve looks "missing" until a late, dramatic rise. Not mobile-specific (identical at any width) and not something to fix in a mobile-reflow pass. **Recommendation for later:** either a log-scale toggle, or a supplementary "peak reached on {date}" callout so the story is legible even when the early curve is visually flat.

## 6. Watchlist table header spacing at 375px (tier c)

**Route:** `/app/watchlist`, 375px. The "ACTIONS" column header sits close to the card's right edge — no overflow (`scrollWidth === innerWidth` confirmed), just visually tight. Cosmetic only.

---

## Admin pages — reviewed, not live-tested

`app.admin.index.tsx`, `app.admin.audit.tsx`, `app.admin.users.index.tsx`, `app.admin.users.$userId.tsx` were checked for the same `grid-cols-[...]`-never-stacks anti-pattern that caused finding 1, and for un-wrapped `<table>` elements that might overflow. Neither pattern was found: every grid in these files is mobile-first (`grid-cols-1` base, `sm:`/`lg:` scale-up — the correct direction), and none of the four pages use a literal HTML `<table>` at all (card/list layouts instead, which reflow naturally). Given `is_admin` has no available test-safe grant path (see Scope above), this is a code-review conclusion, not a live-screenshotted one — flagged honestly rather than skipped silently.

---

## Prevention — the responsive convention going forward

**Root cause of finding 1, generalized:** nothing in this codebase owned "how does identity-plus-numbers reflow on mobile" as a documented pattern — each page's header row was written ad hoc, and the one page that got the direction backwards (mobile-first grid instead of mobile-first stack) shipped that way undetected until this audit. Recording the convention here so it doesn't happen again:

1. **Mobile-first, always.** Write the *stacked* layout as the base (unprefixed) classes, and use `sm:` (640px) to switch to the row/grid layout for wider viewports — never the reverse. This codebase already does this correctly almost everywhere (Dashboard's stat grid, Admin's grids, the feature-card grids on the landing page all use `grid-cols-1 ... sm:grid-cols-2 lg:grid-cols-4`); Stock Detail's header was the one exception, now fixed to match.
2. **"Identity left, numbers right" (desktop) → "identity, then numbers" (mobile), both left-aligned.** The canonical shape: a `flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:justify-between` outer wrapper; the identity block (logo/icon + name/title + optional tag/chip, `flex items-center gap-4`) is always left-aligned; the numbers/value block uses `text-left sm:text-right` — left when stacked full-width on mobile, right-aligned once it's sharing a row with identity at `sm:` and up. This is the exact pattern now used by Stock Detail's header and already used correctly elsewhere.
3. **Spacing scale — no new one needed, just use what's already consistent:** `gap-3`/`gap-4` between closely-related inline items (icon+label, stat value+its unit), `gap-6` between major sections/cards, `p-3`–`p-4` for compact card padding, `p-6` for primary content cards — this is already the app's de facto rhythm (confirmed across Dashboard, Portfolio, Settings, Agent); no page audited here broke it.
4. **Reusable component threshold:** this pass did NOT extract a shared header component, because Stock Detail is currently the only page with this exact shape (logo + name + tag + price block). If a second page needs the identical shape, extract it then — matching this session's established practice (`SearchInputBox`, `NumberInput`, `lib/format/datetime.ts`) of building the shared abstraction once a real second consumer exists, not preemptively.
5. **Tables:** every table in this app that needs one already reflows to a reduced/priority column set at mobile widths (Portfolio's Holdings table drops Sector/Shares/Avg Cost/Price, keeping Symbol/Market Value/P&L) rather than horizontally scrolling — continue that pattern rather than introducing `overflow-x-auto` tables, which this audit found zero instances of and should stay that way.
