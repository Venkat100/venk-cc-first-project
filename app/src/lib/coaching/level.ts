// PLAN.md §6 step 8 (B3) — experience level, derived ONLY from observable
// behaviour (trades placed, instruments used, journalling habit,
// diversification). Explicitly, permanently NEVER from returns or P&L — no
// input to this module is a price, a balance, or a percent return, and none
// ever will be. This is the same "no path reads cash_balance/returns/P&L"
// discipline 0024_progressive_unlocks.sql's unlock_feature() states for
// unlocks; here it's what keeps a losing-but-diligent trader from ever
// ranking below a lucky-but-careless one.
//
// TRANSPARENT BY CONSTRUCTION, not a hidden score: every criterion and its
// per-level bar is a named, fixed number below. computeExperienceLevel
// returns the full breakdown — what's met, what isn't, and exactly what
// would need to change to advance — so the UI can show its work rather than
// a single opaque number.

export type ExperienceLevel = "new" | "developing" | "experienced";

export type ExperienceInputs = {
  /** transactions + option_transactions row count, all-time. */
  tradesPlaced: number;
  /** distinct symbols ever traded (stock or underlying of an option), all-time. */
  distinctInstrumentsUsed: number;
  /** journal_entries count for this user. MUST be supplied by the caller from
   *  the user's OWN authenticated session — journal_entries deliberately has
   *  no service_role grant (see 0023_journal.sql), so this module, like
   *  lib/behavioral/functions.ts before it, never reads journal content or
   *  queries that table itself; it only ever receives a count. */
  journalEntryCount: number;
  /** distinct symbols in CURRENT open holdings (not all-time) — diversification
   *  is about the portfolio right now, not history. */
  currentDistinctHoldings: number;
};

export type CriterionKey = "tradesPlaced" | "distinctInstrumentsUsed" | "journalEntryCount" | "currentDistinctHoldings";

const LABELS: Record<CriterionKey, string> = {
  tradesPlaced: "trades placed",
  distinctInstrumentsUsed: "distinct symbols traded",
  journalEntryCount: "journal entries written",
  currentDistinctHoldings: "distinct symbols currently held",
};

// Named, fixed bars — nothing derived, nothing hidden. A level requires
// clearing at least 3 of these 4 bars (see MIN_CRITERIA_MET below), so no
// single habit (e.g. never diversifying) permanently locks someone out —
// but it still takes broad-based activity, not one inflated number, to
// advance.
const DEVELOPING_BAR: Record<CriterionKey, number> = {
  tradesPlaced: 10,
  distinctInstrumentsUsed: 3,
  journalEntryCount: 3,
  currentDistinctHoldings: 2,
};
const EXPERIENCED_BAR: Record<CriterionKey, number> = {
  tradesPlaced: 30,
  distinctInstrumentsUsed: 6,
  journalEntryCount: 10,
  currentDistinctHoldings: 4,
};
const MIN_CRITERIA_MET = 3; // out of 4, to clear a level's bar

export type CriterionStatus = {
  key: CriterionKey;
  label: string;
  value: number;
  developingBar: number;
  experiencedBar: number;
  metDeveloping: boolean;
  metExperienced: boolean;
};

export type ExperienceLevelResult = {
  level: ExperienceLevel;
  criteria: CriterionStatus[];
  /** Criteria still unmet for the NEXT level up — empty if already "experienced".
   *  Each entry says how much further the raw value needs to go. */
  nextLevelNeeds: { key: CriterionKey; label: string; current: number; target: number }[];
};

export function computeExperienceLevel(inputs: ExperienceInputs): ExperienceLevelResult {
  const keys = Object.keys(DEVELOPING_BAR) as CriterionKey[];
  const criteria: CriterionStatus[] = keys.map((key) => {
    const value = inputs[key];
    return {
      key,
      label: LABELS[key],
      value,
      developingBar: DEVELOPING_BAR[key],
      experiencedBar: EXPERIENCED_BAR[key],
      metDeveloping: value >= DEVELOPING_BAR[key],
      metExperienced: value >= EXPERIENCED_BAR[key],
    };
  });

  const developingMet = criteria.filter((c) => c.metDeveloping).length;
  const experiencedMet = criteria.filter((c) => c.metExperienced).length;

  let level: ExperienceLevel = "new";
  if (experiencedMet >= MIN_CRITERIA_MET) level = "experienced";
  else if (developingMet >= MIN_CRITERIA_MET) level = "developing";

  const targetBar = level === "experienced" ? null : level === "developing" ? EXPERIENCED_BAR : DEVELOPING_BAR;
  const targetMetFlag = level === "experienced" ? null : level === "developing" ? "metExperienced" : "metDeveloping";

  const nextLevelNeeds =
    targetBar && targetMetFlag
      ? criteria
          .filter((c) => !c[targetMetFlag as "metDeveloping" | "metExperienced"])
          .map((c) => ({ key: c.key, label: c.label, current: c.value, target: targetBar[c.key] }))
      : [];

  return { level, criteria, nextLevelNeeds };
}
