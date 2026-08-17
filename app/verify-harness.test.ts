// withRetry backs 13 verify-*.ts scripts' SETUP calls (PLAN.md §6d), but
// across two full staggered-suite runs it fired zero times — the stagger
// alone was enough. That means the retry/backoff/give-up paths have never
// actually been exercised, in production or in the suite itself. A vitest
// unit test deliberately trips them here since verify-*.ts scripts only run
// against real live-provider flakiness, which can't be triggered on demand.
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./verify-harness";

// Real backoff math is seconds-scale (see verify-harness.ts); a tiny
// baseDelayMs keeps this test fast without needing fake timers, and the
// relative behavior (exponential vs. linear, retry count, give-up) is
// identical regardless of the base unit.
const FAST = { baseDelayMs: 1 };

describe("withRetry", () => {
  it("returns the result on the first try without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry("test", fn, FAST);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limit-shaped failure and succeeds once the call recovers", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("429 Too Many Requests")).mockResolvedValueOnce("recovered");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await withRetry("rate-limited call", fn, FAST);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls.some(([line]) => typeof line === "string" && line.includes("rate-limited"))).toBe(true);
    logSpy.mockRestore();
  });

  it("retries a non-rate-limit failure too, without the rate-limited label", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce("recovered");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await withRetry("flaky call", fn, FAST);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls.some(([line]) => typeof line === "string" && line.includes("rate-limited"))).toBe(false);
    logSpy.mockRestore();
  });

  it("gives up after the configured attempt count and throws the LAST error, not the first", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("attempt 1 failed")).mockRejectedValueOnce(new Error("attempt 2 failed")).mockRejectedValueOnce(new Error("attempt 3 failed — final"));
    await expect(withRetry("always failing", fn, { ...FAST, attempts: 3 })).rejects.toThrow("attempt 3 failed — final");
    // Exactly `attempts` calls — no off-by-one extra call after the final failure.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects a custom attempts count", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("429 rate limit"));
    await expect(withRetry("custom attempts", fn, { baseDelayMs: 1, attempts: 5 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
