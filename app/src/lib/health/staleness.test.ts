import { describe, it, expect } from "vitest";
import { findStaleJobs, JOB_STALENESS_SPECS, staleFingerprint } from "./staleness.server";

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

// 2026-08-19: without an explicit fingerprint, Sentry's default stack-trace
// grouping collapses a persistent staleness condition into events on ONE
// issue — a "new issue" alert fires once and goes silent for as long as the
// problem continues. These tests exist to prove the day-boundary behavior
// directly (a non-null check alone proves nothing about whether recurrence
// is actually handled).
describe("staleFingerprint", () => {
  it("the SAME job on the SAME UTC calendar day produces an identical fingerprint, even at different times of day", () => {
    const morning = new Date("2026-08-19T00:00:01.000Z");
    const night = new Date("2026-08-19T23:59:59.000Z");
    expect(staleFingerprint("agent-thinker", morning)).toEqual(staleFingerprint("agent-thinker", night));
  });

  it("the SAME job on DIFFERENT UTC calendar days produces a DIFFERENT fingerprint — this is the entire fix", () => {
    const day1 = new Date("2026-08-19T12:00:00.000Z");
    const day2 = new Date("2026-08-20T12:00:00.000Z");
    const fp1 = staleFingerprint("agent-thinker", day1);
    const fp2 = staleFingerprint("agent-thinker", day2);
    expect(fp1).not.toEqual(fp2);
  });

  it("five consecutive days produce five distinct fingerprints — a persistent problem stays noisy, not just day-2-vs-day-1", () => {
    const fingerprints = Array.from({ length: 5 }, (_, i) => staleFingerprint("agent-thinker", new Date(Date.UTC(2026, 7, 19 + i, 12))));
    const unique = new Set(fingerprints.map((fp) => fp.join("|")));
    expect(unique.size).toBe(5);
  });

  it("crossing a UTC midnight boundary by ONE second changes the fingerprint (not just calendar-day-apart dates)", () => {
    const justBefore = new Date("2026-08-19T23:59:59.000Z");
    const justAfter = new Date("2026-08-20T00:00:00.000Z");
    expect(staleFingerprint("agent-thinker", justBefore)).not.toEqual(staleFingerprint("agent-thinker", justAfter));
  });

  it("different JOBS on the same day produce different fingerprints too — the fix isn't just date-scoped, it's job-scoped", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    expect(staleFingerprint("agent-thinker", now)).not.toEqual(staleFingerprint("daily-brief", now));
  });

  it("fingerprint shape: exactly [\"staleness\", jobName, YYYY-MM-DD]", () => {
    expect(staleFingerprint("snapshot", new Date("2026-08-19T12:00:00.000Z"))).toEqual(["staleness", "snapshot", "2026-08-19"]);
  });
});
