import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentActivityStatusLine } from "./AgentActivityStatusLine";
import type { MinimalDecision } from "@/lib/agent/activityStatus";

// formatInstant renders in the viewer's local zone (datetime.ts) — pin TZ
// so the exact clock strings this test asserts on are deterministic.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const NOW = new Date("2026-08-17T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// AGENT-AUDIT.md Part 8's hard constraint: this component must report
// FACTS only, never a health verdict. Every test below also asserts none
// of the banned reassurance words appear in the rendered output, so a
// future edit that slips one in fails loudly here instead of shipping.
const REASSURANCE_WORDS = /healthy|on track|working correctly|nothing to worry|all good|everything.s fine/i;
function expectNoReassurance(container: HTMLElement) {
  expect(container.textContent).not.toMatch(REASSURANCE_WORDS);
}

describe("AgentActivityStatusLine", () => {
  it("not_started: no decisions at all yet", () => {
    const { container } = render(<AgentActivityStatusLine decisions={[]} now={NOW} />);
    expect(screen.getByText("The agent hasn't run yet.")).toBeInTheDocument();
    expect(screen.getByText(/Next scheduled run/)).toBeInTheDocument();
    // No "Last decision" row when there is no decision history to show one.
    expect(screen.queryByText("Last decision")).not.toBeInTheDocument();
    expectNoReassurance(container);
  });

  it("never_traded, under the 3-day threshold: reports the first-run recency, not a verdict", () => {
    const decisions: MinimalDecision[] = [{ action: "rebalance", symbol: null, created_at: daysAgo(1), rationale: "Portfolio within drift bands — no trades needed." }];
    const { container } = render(<AgentActivityStatusLine decisions={decisions} now={NOW} />);
    expect(screen.getByText("None yet — first run was 1 day ago.")).toBeInTheDocument();
    expect(screen.getByText(/“Portfolio within drift bands/)).toBeInTheDocument();
    expectNoReassurance(container);
  });

  it("never_traded, past the 3-day threshold: states the day count plainly", () => {
    const decisions: MinimalDecision[] = [
      { action: "rebalance", symbol: null, created_at: daysAgo(5), rationale: "Cannot construct a balanced portfolio at this funding level." },
      { action: "rebalance", symbol: null, created_at: daysAgo(1), rationale: "Cannot construct a balanced portfolio at this funding level." },
    ];
    const { container } = render(<AgentActivityStatusLine decisions={decisions} now={NOW} />);
    // "First run" is the OLDEST decision (5 days ago), not the latest.
    expect(screen.getByText("None yet — 5 days since the agent's first run.")).toBeInTheDocument();
    expectNoReassurance(container);
  });

  it("active: a recent real trade renders as the last-acted fact, plus the latest decision separately", () => {
    const decisions: MinimalDecision[] = [
      { action: "buy", symbol: "AMD", created_at: daysAgo(2), rationale: "Bought AMD: momentum + beta fit the aggressive profile." },
      { action: "rebalance", symbol: null, created_at: daysAgo(1), rationale: "Portfolio within drift bands — no trades needed." },
    ];
    const { container } = render(<AgentActivityStatusLine decisions={decisions} now={NOW} />);
    expect(screen.getByText(/Bought AMD — 2 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/“Portfolio within drift bands — no trades needed\.”/)).toBeInTheDocument();
    expectNoReassurance(container);
  });

  it("quiet: past the 14-day threshold since the last real trade", () => {
    const decisions: MinimalDecision[] = [
      { action: "trim", symbol: "NVDA", created_at: daysAgo(20), rationale: "Trimmed NVDA: beyond the drift band." },
      { action: "rebalance", symbol: null, created_at: daysAgo(3), rationale: "Portfolio within drift bands — no trades needed." },
    ];
    const { container } = render(<AgentActivityStatusLine decisions={decisions} now={NOW} />);
    expect(screen.getByText(/Trimmed NVDA — 20 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/“Portfolio within drift bands — no trades needed\.”/)).toBeInTheDocument();
    expectNoReassurance(container);
  });

  it("always renders a next-scheduled-run time, in every state", () => {
    const states: MinimalDecision[][] = [
      [],
      [{ action: "rebalance", symbol: null, created_at: daysAgo(1), rationale: "x" }],
      [{ action: "buy", symbol: "NVDA", created_at: daysAgo(1), rationale: "x" }],
    ];
    for (const decisions of states) {
      const { unmount } = render(<AgentActivityStatusLine decisions={decisions} now={NOW} />);
      expect(screen.getByText(/Next scheduled run/)).toBeInTheDocument();
      unmount();
    }
  });
});
