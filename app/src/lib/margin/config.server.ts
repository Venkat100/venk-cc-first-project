// Margin engine config (M1) — documented, deliberately simplified constants.
// Educational simulation of Reg-T-style margin, NOT a real broker's rule
// set: no per-security nuance, no portfolio margin, no special cases.

/** 2:1 leverage — a simplified simulation of Reg-T's 50% initial margin
 *  requirement (buying_power = 2 × equity − positions_value when margin is
 *  on). A refinement lever like RISK_FREE_RATE in the options engine, not
 *  sourced from a live regulatory feed. */
export const MARGIN_MAX_LEVERAGE = 2;

/** Annual margin interest rate, accrued daily as `loan × rate / 365` and
 *  ADDED TO THE LOAN (capitalized, not charged to cash — see 0012's header
 *  comment for why). 8% sits in the middle of real brokers' typical margin
 *  rates; a documented constant, not a live rate feed. */
export const MARGIN_INTEREST_RATE = 0.08;

/** Maintenance requirement as a fraction of positions_value. A common
 *  broker-ish level (real brokers commonly run 25%–40% depending on the
 *  security) — NOT FINRA's literal 25% regulatory floor, a deliberately
 *  slightly more conservative simulated number so a margin call fires with
 *  some safety margin baked in. */
export const MARGIN_MAINTENANCE_PCT = 0.3;

/** 'warning' status fires when equity is within this fraction ABOVE the
 *  maintenance requirement (i.e. equity < maintenance_req × (1 + this)) —
 *  a heads-up before an actual call, not a hard rule from any real broker. */
export const MARGIN_WARNING_BUFFER_PCT = 0.1;
