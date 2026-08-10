// US equity regular-session check — pure, no server-only dependencies (just
// Intl, available in both Node and the browser), so this is the ONE source
// of truth for BOTH the server-side agent cron gate (lib/agent/cron.server.ts)
// and the client-side live-price polling gate (useMarketLive.ts). Moved out
// of cron.server.ts specifically so a client component can import it without
// pulling in server-only code — this file has no secrets and makes no
// network call, so it's safe to ship to the browser.

/** US equity regular session: Mon–Fri, 9:30–16:00 America/New_York
 *  (DST-aware via Intl — no manual EST/EDT offset math). Holidays are not
 *  excluded — an off-day check just reads "closed" a little early/late,
 *  never wrongly "open". */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (hour === 24) hour = 0; // some runtimes render midnight as "24"
  if (weekday === "Sat" || weekday === "Sun") return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
