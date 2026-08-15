// A single, shared "is this a fund?" signal plus a display-safe sector
// label — every UI that groups or renders a symbol's sector should go
// through these two functions rather than reading `Quote.sector` directly.
//
// Finnhub's /stock/profile2 is empty for ETFs/funds — confirmed live
// (2026-08-15, the Portfolio "Allocation by sector" dash fix) against 5 real
// ETFs (VOO/QQQ/SPY/ARKK/IWM: all blank sector AND undefined marketCap) vs.
// 10 ordinary stocks across 8 distinct real sectors (all populated on both
// fields). Requiring BOTH conditions together is what distinguishes "this
// is a fund" from "the sector genuinely couldn't be determined for some
// other reason" — a stock missing just its sector would still carry a
// market cap; a fund is missing its entire profile at once.
export function isLikelyFund(q: { marketCap?: number; sector: string }): boolean {
  return !q.marketCap && (!q.sector || q.sector === "—");
}

// The ONE safe label for any UI that groups or displays a symbol's sector.
// Never returns the raw "—" sentinel Quote.sector uses internally — a chart
// legend entry or table cell must always be identifiable on its own.
export function displaySector(q: { marketCap?: number; sector: string }): string {
  if (isLikelyFund(q)) return "ETFs & funds";
  if (q.sector && q.sector !== "—") return q.sector;
  return "Unclassified";
}
