// PLAN.md §6 step 9 (B5) — Scenario Challenges catalog.
//
// Deliberately CODE-DEFINED, not DB rows: there are only 3, curated,
// carefully chosen scenarios and they rarely change — a migration + admin
// UI to manage them would be premature machinery for v1. `scenario_runs.
// scenario_id` (0025_scenario_challenges.sql) is a plain text key matching
// `id` below.
//
// Every symbol/date range here was VERIFIED against real Twelve Data
// history before being locked in (verify-scenario-data-availability.ts) —
// no scenario ships with a symbol whose free-tier history doesn't actually
// reach back that far.
//
// Pure module: no DB/network imports. Server functions (functions.ts) read
// this catalog to know what to fetch/validate; the client reads it to
// render the picker and trade panel — same isomorphic convention as
// lib/coaching/quiz.ts.

export type ScenarioId = "2008-crisis" | "2020-covid" | "2022-bear";

export type ScenarioSymbol = {
  symbol: string;
  /** One-line "why this one" — shown in the picker and trade panel. */
  blurb: string;
};

export type Scenario = {
  id: ScenarioId;
  title: string;
  tagline: string;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. */
  endDate: string;
  startingCash: number;
  /** Tradeable symbols for this scenario (5-8 tickers, curated). */
  symbols: ScenarioSymbol[];
  /** Always included as the benchmark — never tradeable as a "pick", but
   *  its own buy-and-hold return is the comparison line. Also doubles as
   *  the scenario's trading-day calendar (see lib/scenarios/functions.ts). */
  benchmarkSymbol: "SPY";
  /** How many trading days one "advance" step covers. Day-stepping across a
   *  6-12 month window is 150-250 clicks — too slow to be playable; week-
   *  stepping (5 trading days/step) cuts that to 30-50, still shows the
   *  crash unfold day-by-day on the chart (daily candles are still
   *  rendered), just advances the cursor in bigger jumps. */
  stepTradingDays: number;
  /** Shown only once the run is completed — the educational payoff. Written
   *  plainly, historically factual, never AI-generated (matches the app's
   *  "computed, not AI-generated" convention elsewhere). */
  debrief: string;
};

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  "2008-crisis": {
    id: "2008-crisis",
    title: "The 2008 Financial Crisis",
    tagline: "A housing bubble, a bank collapse, and a market that lost half its value.",
    startDate: "2008-06-02",
    endDate: "2009-06-01",
    startingCash: 10_000,
    benchmarkSymbol: "SPY",
    stepTradingDays: 5,
    symbols: [
      { symbol: "AIG", blurb: "Insurance giant, brought to the brink by credit-default-swap bets — bailed out by the government days after Lehman fell." },
      { symbol: "C", blurb: "Citigroup — one of the hardest-hit major banks, took multiple rounds of federal bailout money." },
      { symbol: "BAC", blurb: "Bank of America — acquired a crumbling Merrill Lynch mid-crisis, then absorbed its losses." },
      { symbol: "AAPL", blurb: "A growth tech name — fell hard with the broad market despite having nothing to do with housing or banks." },
      { symbol: "WMT", blurb: "Discount retailer — the closest thing to a 'safe haven' stock in this set; people still need groceries in a recession." },
      { symbol: "XOM", blurb: "Oil major — commodity prices swung wildly as the crisis hit global demand." },
    ],
    debrief:
      "The crisis had been building for years: a housing bubble fueled by subprime mortgages and mortgage-backed securities sold as safe. Lehman Brothers collapsed on September 15, 2008, freezing credit markets overnight. AIG needed an emergency federal bailout days later. The S&P 500 fell roughly 50% peak-to-trough before finally bottoming in March 2009 — and then began one of the longest bull markets in history. The lesson isn't 'the market always comes back' (it doesn't, always, everywhere) — it's that panic-selling at the bottom locks in the loss, and nobody rings a bell at the turn. Diversified, patient positioning mattered more than picking the exact right bank stock.",
  },
  "2020-covid": {
    id: "2020-covid",
    title: "The COVID-19 Crash",
    tagline: "The fastest bear market in history — and one of the fastest recoveries.",
    startDate: "2020-01-02",
    endDate: "2020-08-28",
    startingCash: 10_000,
    benchmarkSymbol: "SPY",
    stepTradingDays: 5,
    symbols: [
      { symbol: "ZM", blurb: "Zoom — went from a niche tool to a household name overnight as the world went remote." },
      { symbol: "AMZN", blurb: "E-commerce boomed as people stopped going to physical stores — a huge structural winner." },
      { symbol: "CCL", blurb: "Carnival Cruise Line — an entire industry effectively shut down for months." },
      { symbol: "DAL", blurb: "Delta Air Lines — global air travel collapsed almost to zero within weeks." },
      { symbol: "TSLA", blurb: "Already volatile, then wildly amplified by the crash and the recovery that followed." },
      { symbol: "XOM", blurb: "Oil demand cratered with global lockdowns — futures prices briefly went negative that April." },
    ],
    debrief:
      "The S&P 500 fell about 34% in just 23 trading days (Feb 19 – Mar 23, 2020) — the fastest bear market in market history, as lockdowns shut down huge parts of the economy essentially overnight. The Federal Reserve responded with unprecedented speed: emergency rate cuts to zero and massive asset purchases within days, not months. The market bottomed on March 23 and had fully recovered its losses by August — a V-shape nobody could have called with confidence in real time. The winners and losers were unusually obvious in hindsight (remote work vs. travel/leisure) but genuinely terrifying to hold through at the time — which is exactly why this scenario exists: knowing the outcome in advance is nothing like living through the uncertainty.",
  },
  "2022-bear": {
    id: "2022-bear",
    title: "The 2022 Bear Market",
    tagline: "Inflation, rate hikes, and a slow grind down — the opposite of a crash.",
    startDate: "2022-01-03",
    endDate: "2022-12-29",
    startingCash: 10_000,
    benchmarkSymbol: "SPY",
    stepTradingDays: 5,
    symbols: [
      { symbol: "NFLX", blurb: "Netflix — lost a huge share of its value in a single day in April on a subscriber-growth miss." },
      { symbol: "META", blurb: "Facebook's parent — hit hard by ad-spending pullback and skepticism about its 'metaverse' pivot." },
      { symbol: "TSLA", blurb: "High-growth, high-valuation names got hit hardest as interest rates rose." },
      { symbol: "AAPL", blurb: "A relatively resilient mega-cap — still fell with the market, but by less than most." },
      { symbol: "WMT", blurb: "Defensive retail again — consumers trade down to discount stores when inflation bites." },
      { symbol: "XOM", blurb: "Energy was the standout winner of 2022 — oil prices spiked after Russia's invasion of Ukraine." },
    ],
    debrief:
      "2022 had no single crash day — it was a long, grinding decline as the Federal Reserve raised interest rates aggressively to fight the highest inflation in 40 years. The S&P 500 fell about 19-25% peak-to-trough (varying by measurement window), but slowly, over months, which is psychologically harder for a lot of investors than a sharp crash: there's no obvious bottom to 'buy the dip' at, and every recovery attempt during the year was followed by a new low. Growth and high-valuation tech stocks (Netflix, Meta, Tesla) fell hardest since rising rates make their far-off future profits worth less today. Energy was the rare bright spot, driven by real supply shocks from the war in Ukraine — a reminder that a bear market rarely hits every sector evenly.",
  },
};

export function getScenario(id: string): Scenario | null {
  return (SCENARIOS as Record<string, Scenario>)[id] ?? null;
}

export function listScenarios(): Scenario[] {
  return Object.values(SCENARIOS);
}

/** All tradeable symbols for a scenario, INCLUDING the benchmark — the set
 *  the server is willing to fetch/validate trades against. Trading the
 *  benchmark itself is allowed (SPY is a legitimate "just hold the index"
 *  choice), it's simply never presented as a "pick" with its own blurb. */
export function scenarioSymbolSet(scenario: Scenario): string[] {
  return [...scenario.symbols.map((s) => s.symbol), scenario.benchmarkSymbol];
}
