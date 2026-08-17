// A single, shared "is this a fund?" signal plus a display-safe sector
// label — every UI that groups or renders a symbol's sector should go
// through these two functions rather than reading `Quote.sector` directly.
// Every known consumer (Markets sector chips, the Portfolio "Allocation by
// sector" chart + holdings table, the Stock Detail "About" card's
// fund-vs-stock branch) shares this one implementation, so a fix here
// fixes all of them at once.
//
// Finnhub's /stock/profile2 is empty for ETFs/funds — confirmed live
// (2026-08-15, the Portfolio "Allocation by sector" dash fix) against 5 real
// ETFs (VOO/QQQ/SPY/ARKK/IWM: all blank sector AND undefined marketCap) vs.
// 10 ordinary stocks across 8 distinct real sectors (all populated on both
// fields). Requiring BOTH conditions together is what distinguishes "this
// is a fund" from "the sector genuinely couldn't be determined for some
// other reason" — a stock missing just its sector would still carry a
// market cap; a fund is missing its entire profile at once.
//
// `ok` gate (2026-08-16): a quote whose fetch FAILED is built from the exact
// same zeroed shape as a real fund's blank profile (no marketCap, sector
// "—") — before Quote carried an explicit `ok` field, isLikelyFund had no
// way to tell them apart and silently misclassified a failed fetch as a
// confirmed fund. `ok === false` is checked first and unconditionally wins,
// so a failed/unloaded quote is never mistaken for a real classification in
// either function.
export function isLikelyFund(q: { marketCap?: number; sector: string; ok?: boolean }): boolean {
  if (q.ok === false) return false;
  return !q.marketCap && (!q.sector || q.sector === "—");
}

// The ONE safe label for any UI that groups or displays a symbol's sector.
// Never returns the raw "—" sentinel Quote.sector uses internally — a chart
// legend entry or table cell must always be identifiable on its own.
export function displaySector(q: { marketCap?: number; sector: string; ok?: boolean }): string {
  if (q.ok === false) return "Unavailable";
  if (isLikelyFund(q)) return "ETFs & funds";
  if (q.sector && q.sector !== "—") return q.sector;
  return "Unclassified";
}
