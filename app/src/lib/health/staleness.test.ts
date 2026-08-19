import { describe, it, expect } from "vitest";
import { findStaleJobs, JOB_STALENESS_SPECS } from "./staleness.server";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

const allFresh = () => JOB_STALENESS_SPECS.map((spec) => ({ job_name: spec.jobName, last_run_at: hoursAgo(0) }));

describe("findStaleJobs", () => {
  it("no heartbeats at all -> every tracked job is reported stale (never-seen, not just old)", () => {
    const stale = findStaleJobs([], NOW);
    expect(stale.map((s) => s.jobName).sort()).toEqual(JOB_STALENESS_SPECS.map((s) => s.jobName).sort());
    for (const s of stale) expect(s.lastRunAt).toBeNull();
    for (const s of stale) expect(s.ageHours).toBeNull();
  });

  it("every job fresh right now -> nothing is stale", () => {
    expect(findStaleJobs(allFresh(), NOW)).toEqual([]);
  });

  for (const spec of JOB_STALENESS_SPECS) {
    it(`${spec.jobName}: exactly at its ${spec.staleAfterHours}h threshold IS flagged (boundary is inclusive)`, () => {
      const heartbeats = allFresh().map((h) => (h.job_name === spec.jobName ? { ...h, last_run_at: hoursAgo(spec.staleAfterHours) } : h));
      const stale = findStaleJobs(heartbeats, NOW);
      expect(stale.map((s) => s.jobName)).toEqual([spec.jobName]);
    });

    it(`${spec.jobName}: one hour short of its ${spec.staleAfterHours}h threshold is NOT flagged`, () => {
      const heartbeats = allFresh().map((h) => (h.job_name === spec.jobName ? { ...h, last_run_at: hoursAgo(spec.staleAfterHours - 1) } : h));
      const stale = findStaleJobs(heartbeats, NOW);
      expect(stale).toEqual([]);
    });
  }

  it("an untracked job_name in the heartbeats table is ignored — findStaleJobs only reports jobs in JOB_STALENESS_SPECS", () => {
    const heartbeats = [...allFresh(), { job_name: "some-future-job", last_run_at: hoursAgo(1000) }];
    expect(findStaleJobs(heartbeats, NOW)).toEqual([]);
  });

  it("reports accurate ageHours for a stale job", () => {
    const heartbeats = allFresh().map((h) => (h.job_name === "daily-brief" ? { ...h, last_run_at: hoursAgo(72) } : h));
    const stale = findStaleJobs(heartbeats, NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0].jobName).toBe("daily-brief");
    expect(stale[0].ageHours).toBeCloseTo(72, 5);
  });
});
