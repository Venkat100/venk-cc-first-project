// The ONE date/time formatting layer for the whole app — same pattern as
// SearchInputBox and NumberInput: one canonical implementation, every call
// site migrated to it, so a class of bug (here: a timestamp rendering in
// the wrong zone) can't reappear one call site at a time.
//
// Two distinct kinds of value flow through this app, and they are NOT
// interchangeable:
//
//   INSTANT  — "when did this happen" (a trade, a decision, an insight
//   generation, an admin event). Stored as a real UTC timestamp
//   (`toISOString()`-style, trailing "Z"). MUST render in the VIEWER's own
//   local zone — that's what `formatInstant`/`formatInstantDate` do, via
//   `toLocaleString(undefined, …)`/`toLocaleDateString(undefined, …)`,
//   which read the browser's own `Intl` default zone. Never pass an
//   explicit `timeZone` for these — that would hard-code one viewer's zone
//   for everyone.
//
//   CALENDAR DATE — "which day" (an option's expiry, a portfolio snapshot
//   day, a What-If investment date, an earnings date, a market brief's
//   covered trading day). Stored as a bare `YYYY-MM-DD` with no time
//   component. These are rendered in UTC ON PURPOSE: the date string IS
//   the canonical day, and converting it through the viewer's local zone
//   would shift it to the wrong calendar day for anyone west of UTC (a
//   date-only string parses as UTC midnight; subtracting a positive UTC
//   offset rolls it back to the previous day). `formatCalendarDate` always
//   passes `timeZone: "UTC"` for exactly this reason — this is NOT the
//   same bug as an instant rendering in the wrong zone, and must not be
//   "corrected" into using the viewer's zone.
//
// Market-hours logic (isUsMarketOpen, marketHours.ts) is a third, separate
// category deliberately NOT covered here: US equity market hours are
// America/New_York by definition, not the viewer's zone, and already use
// Intl's America/New_York explicitly — that's correct as-is and out of
// scope for this file.

const DEFAULT_INSTANT_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const DEFAULT_INSTANT_WITH_YEAR_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
const DEFAULT_INSTANT_DATE_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
const DEFAULT_CALENDAR_DATE_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/** A real UTC instant (ISO timestamp) → date + time, in the VIEWER's local zone. */
export function formatInstant(iso: string, opts: Intl.DateTimeFormatOptions = DEFAULT_INSTANT_OPTS): string {
  return new Date(iso).toLocaleString(undefined, opts);
}

/** Same as formatInstant, with the year included — for contexts spanning more than one year. */
export function formatInstantWithYear(iso: string): string {
  return formatInstant(iso, DEFAULT_INSTANT_WITH_YEAR_OPTS);
}

/** A real UTC instant → date only (no time-of-day), in the VIEWER's local zone. */
export function formatInstantDate(iso: string, opts: Intl.DateTimeFormatOptions = DEFAULT_INSTANT_DATE_OPTS): string {
  return new Date(iso).toLocaleDateString(undefined, opts);
}

/** A Unix-seconds instant (e.g. a news article's `datetime`) → date, in the VIEWER's local zone. */
export function formatUnixSecondsDate(unixSeconds: number, opts: Intl.DateTimeFormatOptions = DEFAULT_INSTANT_DATE_OPTS): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, opts);
}

/**
 * A calendar date (no REAL time-of-day component) → rendered in UTC
 * regardless of viewer, so the displayed day always matches the date
 * string exactly. See this file's header comment for why UTC is correct
 * here and NOT a bug to "fix" into the viewer's local zone.
 *
 * Accepts either a bare `YYYY-MM-DD` (a Postgres `date` column, e.g.
 * portfolio_snapshots.captured_at, scenario sim_date) or a full
 * UTC-midnight ISO instant string (a daily provider candle's `t`, built via
 * `new Date(...).toISOString()` — genuinely a calendar day with no real
 * intraday time, just serialized with a time component tacked on). Only
 * the first 10 characters (the date portion) are ever used, so appending
 * "T00:00:00Z" can't double up into an invalid string either way — passing
 * a full ISO string here is not a second time value being interpreted,
 * it's the same calendar day represented differently by its source.
 */
export function formatCalendarDate(dateOnly: string, opts: Intl.DateTimeFormatOptions = DEFAULT_CALENDAR_DATE_OPTS): string {
  return new Date(`${dateOnly.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}
