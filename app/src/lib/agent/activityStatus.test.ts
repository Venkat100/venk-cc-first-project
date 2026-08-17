import { describe, it, expect } from "vitest";
import { computeAgentActivityStatus, nextAgentThinkerRunIso, isIdle, NEVER_TRADED_IDLE_DAYS, WENT_QUIET_DAYS, type MinimalDecision } from "./activityStatus";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("computeAgentActivityStatus", () => {
  it("no decisions at all -> not_started", () => {
    expect(computeAgentActivityStatus([], NOW)).toEqual({ kind: "not_started" });
  });

  it("never-traded, exactly one day short of the threshold, is not flagged idle", () => {
    const decisions: MinimalDecision[] = [{ action: "rebalance", symbol: null, created_at: daysAgo(NEVER_TRADED_IDLE_DAYS - 1), rationale: "x" }];
    const status = computeAgentActivityStatus(decisions, NOW);
    expect(status.kind).toBe("never_traded");
    expect(status.kind === "never_traded" && status.pastThreshold).toBe(false);
    expect(isIdle(status)).toBe(false);
  });

  it("never-traded, exactly at the threshold, IS flagged idle (boundary is inclusive)", () => {
    const decisions: MinimalDecision[] = [{ action: "rebalance", symbol: null, created_at: daysAgo(NEVER_TRADED_IDLE_DAYS), rationale: "x" }];
    const status = computeAgentActivityStatus(decisions, NOW);
    expect(status.kind).toBe("never_traded");
    expect(status.kind === "never_traded" && status.pastThreshold).toBe(true);
    expect(isIdle(status)).toBe(true);
  });

  it("a real trade among a run of hold/rebalance rows is found regardless of position", () => {
    const decisions: MinimalDecision[] = [
      { action: "rebalance", symbol: null, created_at: daysAgo(10), rationale: "x" },
      { action: "buy", symbol: "AMD", created_at: daysAgo(8), rationale: "x" },
      { action: "hold", symbol: "NVDA", created_at: daysAgo(1), rationale: "cooldown" },
    ];
    const status = computeAgentActivityStatus(decisions, NOW);
    expect(status.kind).toBe("active"); // 8 days < WENT_QUIET_DAYS
    if (status.kind === "active") {
      expect(status.lastTradeSummary).toBe("Bought AMD");
      expect(status.sinceDays).toBe(8);
    }
  });

  it("a hold/rebalance/watchdog row alone never counts as a real trade", () => {
    const decisions: MinimalDecision[] = [
      { action: "hold", symbol: "NVDA", created_at: daysAgo(1), rationale: "cooldown" },
      { action: "watchdog", symbol: null, created_at: daysAgo(1), rationale: "checked 3 holdings" },
      { action: "rebalance", symbol: null, created_at: daysAgo(1), rationale: "no trades needed" },
    ];
    expect(computeAgentActivityStatus(decisions, NOW).kind).toBe("never_traded");
  });

  it("active exactly one day short of going quiet is still active, not quiet", () => {
    const decisions: MinimalDecision[] = [{ action: "sell", symbol: "AMZN", created_at: daysAgo(WENT_QUIET_DAYS - 1), rationale: "x" }];
    expect(computeAgentActivityStatus(decisions, NOW).kind).toBe("active");
  });

  it("goes quiet exactly at the threshold (boundary is inclusive)", () => {
    const decisions: MinimalDecision[] = [{ action: "sell", symbol: "AMZN", created_at: daysAgo(WENT_QUIET_DAYS), rationale: "x" }];
    const status = computeAgentActivityStatus(decisions, NOW);
    expect(status.kind).toBe("quiet");
    expect(isIdle(status)).toBe(true);
  });

  it("does not require decisions to be pre-sorted", () => {
    const decisions: MinimalDecision[] = [
      { action: "buy", symbol: "AAPL", created_at: daysAgo(1), rationale: "newest" },
      { action: "buy", symbol: "MSFT", created_at: daysAgo(9), rationale: "oldest real trade" },
      { action: "hold", symbol: null, created_at: daysAgo(5), rationale: "middle" },
    ];
    const status = computeAgentActivityStatus(decisions, NOW);
    expect(status.kind).toBe("active");
    if (status.kind === "active") expect(status.lastTradeSummary).toBe("Bought AAPL"); // most recent, not first-in-array
  });
});

describe("nextAgentThinkerRunIso", () => {
  it("returns later today when before 21:30 UTC", () => {
    const now = new Date("2026-08-17T10:00:00.000Z");
    expect(nextAgentThinkerRunIso(now)).toBe("2026-08-17T21:30:00.000Z");
  });

  it("rolls to tomorrow when at or after 21:30 UTC", () => {
    const now = new Date("2026-08-17T21:30:00.000Z");
    expect(nextAgentThinkerRunIso(now)).toBe("2026-08-18T21:30:00.000Z");
  });
});
