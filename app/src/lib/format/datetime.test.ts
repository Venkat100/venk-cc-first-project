// Direct unit coverage for every exported function in this file — the gap
// that let the "Invalid Date" regression (formatCalendarDate fed a full ISO
// instant instead of the bare YYYY-MM-DD it assumed) ship to production
// through a green 35-script verify-*.ts suite: that suite verifies data and
// server logic, never asserts on rendered output, so a pure formatting bug
// passes it silently. These tests exist to make that specific class of bug
// fail loudly if it's ever reintroduced, here or in a future edit.
//
// Timezone tests mutate process.env.TZ per-assertion (restored after each)
// rather than relying on the machine's default zone, matching the technique
// already used for the live TZ=... vite-node checks earlier in this
// project's history — Node's ICU-backed Intl re-reads TZ on every call, not
// just at process start, so this is safe to do repeatedly within one file.
// AM/PM output is normalized (collapsing whatever whitespace character ICU
// puts before it) before comparison — the regression this file guards
// against is wrong-day/wrong-instant output, not which Unicode space
// character a given Node/ICU version puts before "PM".
import { describe, it, expect, afterEach } from "vitest";
import { formatInstant, formatInstantWithYear, formatInstantDate, formatUnixSecondsDate, formatCalendarDate, nextUtcMidnightIso } from "./datetime";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function withTZ<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  return fn();
}

function norm(s: string): string {
  return s.replace(/\s/g, " ");
}

describe("formatInstant", () => {
  it("renders a UTC instant in the viewer's local zone", () => {
    const out = withTZ("America/Chicago", () => formatInstant("2026-08-17T04:15:31.661Z"));
    // 04:15 UTC on Aug 17 is 11:15 PM CDT on Aug 16 — the local day is
    // DIFFERENT from the UTC day, which is the whole point of this function.
    expect(norm(out)).toBe("Aug 16, 11:15 PM");
  });

  it("renders the SAME instant differently in a different zone", () => {
    const out = withTZ("Asia/Kolkata", () => formatInstant("2026-08-17T04:15:31.661Z"));
    expect(norm(out)).toBe("Aug 17, 9:45 AM");
  });

  it("accepts custom Intl options", () => {
    const out = withTZ("UTC", () => formatInstant("2026-01-01T00:00:00Z", { month: "long", day: "numeric" }));
    expect(out).toBe("January 1");
  });
});

describe("formatInstantWithYear", () => {
  it("includes the year alongside date and time", () => {
    const out = withTZ("UTC", () => formatInstantWithYear("2026-03-05T12:00:00Z"));
    expect(norm(out)).toBe("Mar 5, 2026, 12:00 PM");
  });
});

describe("formatInstantDate", () => {
  it("renders date only (no time-of-day), in the viewer's local zone", () => {
    // Same instant as the formatInstant Chicago case — local day is Aug 16,
    // one day behind the UTC day, and the date-only render must agree.
    const out = withTZ("America/Chicago", () => formatInstantDate("2026-08-17T04:15:31.661Z"));
    expect(out).toBe("Aug 16, 2026");
  });
});

describe("formatUnixSecondsDate", () => {
  it("converts unix seconds to a viewer-local date", () => {
    // 1735689600 = 2025-01-01T00:00:00Z
    const out = withTZ("UTC", () => formatUnixSecondsDate(1735689600));
    expect(out).toBe("Jan 1, 2025");
  });
});

describe("formatCalendarDate", () => {
  it("renders a bare YYYY-MM-DD in UTC regardless of viewer zone", () => {
    const east = withTZ("Pacific/Kiritimati", () => formatCalendarDate("2026-09-19")); // UTC+14
    const west = withTZ("Etc/GMT+12", () => formatCalendarDate("2026-09-19")); // UTC-12
    expect(east).toBe("Sep 19, 2026");
    expect(west).toBe("Sep 19, 2026");
  });

  it("REGRESSION: accepts a full ISO instant string (a daily candle's t) without producing an invalid date", () => {
    // This exact shape — new Date(v.datetime).toISOString(), built in
    // provider.server.ts for every daily candle — is what SimulatorPanel.tsx
    // and LivePriceChart.tsx actually pass. Before formatCalendarDate sliced
    // its input, appending "T00:00:00Z" onto this already-complete string
    // produced "...ZT00:00:00Z", which Date() silently turns into an
    // Invalid Date — this is the literal input that shipped "Invalid Date"
    // to the What-If Simulator's X-axis and the Stock Detail price chart's
    // tooltip in production.
    const out = withTZ("America/Chicago", () => formatCalendarDate("2019-06-03T00:00:00.000Z"));
    expect(out.toLowerCase()).not.toContain("invalid");
    expect(out).toBe("Jun 3, 2019");
  });

  it("a bare date and the full-ISO form of the same day render identically", () => {
    const bare = withTZ("Asia/Tokyo", () => formatCalendarDate("2024-12-25"));
    const full = withTZ("Asia/Tokyo", () => formatCalendarDate("2024-12-25T00:00:00.000Z"));
    expect(full).toBe(bare);
  });

  it("is immune to viewer zone even at the UTC-day boundary", () => {
    // A viewer far west of UTC (Etc/GMT+12) is the classic footgun for a
    // date-only string parsed through toLocaleDateString with no explicit
    // UTC timeZone — the day would roll back by one. Confirm it doesn't.
    const out = withTZ("Etc/GMT+12", () => formatCalendarDate("2026-01-01"));
    expect(out).toBe("Jan 1, 2026");
  });
});

describe("nextUtcMidnightIso", () => {
  it("returns the next UTC midnight strictly after `from`", () => {
    expect(nextUtcMidnightIso(new Date("2026-08-17T04:15:31.661Z"))).toBe("2026-08-18T00:00:00.000Z");
  });

  it("rolls over correctly from the very last instant of a UTC day", () => {
    expect(nextUtcMidnightIso(new Date("2026-08-17T23:59:59.999Z"))).toBe("2026-08-18T00:00:00.000Z");
  });

  it("handles a year boundary", () => {
    expect(nextUtcMidnightIso(new Date("2026-12-31T12:00:00Z"))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("is independent of the viewer's local zone — the rollover is a UTC instant, not a local one", () => {
    const from = new Date("2026-08-17T04:15:31.661Z");
    const chicago = withTZ("America/Chicago", () => nextUtcMidnightIso(from));
    const kolkata = withTZ("Asia/Kolkata", () => nextUtcMidnightIso(from));
    expect(chicago).toBe(kolkata);
    expect(chicago).toBe("2026-08-18T00:00:00.000Z");
  });
});
