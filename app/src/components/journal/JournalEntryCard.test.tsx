import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { JournalEntryCard } from "./JournalEntryCard";
import type { JournalEntry } from "@/lib/supabase/types";
import type { JournalOutcome } from "@/lib/journal/outcome";

// entry_date is a Postgres `date` column (CALENDAR DATE) rendered via
// formatCalendarDate, which pins to UTC on purpose — see datetime.ts's
// header comment. A viewer west of UTC is the only way the historical bug
// (using formatInstantDate here instead) is observable, so the whole suite
// runs under a fixed negative-offset zone.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles"; // UTC-7/-8
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const NONE_OUTCOME: JournalOutcome = { kind: "none" };

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "entry-1",
    user_id: "user-1",
    transaction_id: null,
    option_transaction_id: null,
    symbol: "NVDA",
    title: "Bought the dip",
    body: "Felt confident given the earnings beat.",
    entry_date: "2026-08-17",
    created_at: "2026-08-17T02:00:00.000Z",
    updated_at: "2026-08-17T02:00:00.000Z",
    ...overrides,
  };
}

describe("JournalEntryCard", () => {
  it("renders entry_date as its own calendar day, not shifted a day early for a viewer west of UTC", () => {
    render(<JournalEntryCard entry={makeEntry()} outcome={NONE_OUTCOME} onEdit={() => {}} onDelete={() => {}} />);
    // The historical bug (entry_date routed through formatInstantDate)
    // rendered "Aug 16, 2026" here under America/Los_Angeles — one day
    // early — since a bare date string parses as UTC midnight and
    // formatInstantDate has no UTC pin.
    expect(screen.getByText("Aug 17, 2026")).toBeInTheDocument();
    expect(screen.queryByText("Aug 16, 2026")).not.toBeInTheDocument();
  });

  it("renders the entry body and title", () => {
    render(<JournalEntryCard entry={makeEntry()} outcome={NONE_OUTCOME} onEdit={() => {}} onDelete={() => {}} />);
    expect(screen.getByText("Bought the dip")).toBeInTheDocument();
    expect(screen.getByText("Felt confident given the earnings beat.")).toBeInTheDocument();
  });
});
