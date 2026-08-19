import { describe, it, expect } from "vitest";
import { shuffle, mapWithConcurrency } from "./batchUtils";

describe("shuffle", () => {
  it("returns a new array, never mutating the input", () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffle(input, () => 0.999);
    expect(input).toEqual(copy);
  });

  it("preserves every element, including duplicates — same multiset in, same multiset out", () => {
    const input = ["a", "b", "b", "c"];
    const out = shuffle(input, () => 0.5);
    expect(out.slice().sort()).toEqual(input.slice().sort());
  });

  it("empty and single-element inputs pass through unchanged", () => {
    expect(shuffle([], () => 0.5)).toEqual([]);
    expect(shuffle([1], () => 0.5)).toEqual([1]);
  });

  it("a deterministic rng always spread makes it produce a deterministic order", () => {
    const input = [1, 2, 3, 4, 5];
    const a = shuffle(input, () => 0.5);
    const b = shuffle(input, () => 0.5);
    expect(a).toEqual(b);
  });

  it("with rng always returning 0, every swap targets index 0 — verifies the exact Fisher-Yates permutation, not just multiset equality", () => {
    // i=4: j=floor(0*5)=0 -> swap(4,0); i=3: j=0 -> swap(3,0); i=2: j=0 -> swap(2,0); i=1: j=0 -> swap(1,0)
    // [1,2,3,4,5] -> [5,2,3,4,1] -> [4,2,3,5,1] -> [3,2,4,5,1] -> [2,3,4,5,1]
    const out = shuffle([1, 2, 3, 4, 5], () => 0);
    expect(out).toEqual([2, 3, 4, 5, 1]);
  });

  it("real Math.random usage (no rng arg) still returns a permutation of the same elements", () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffle(input);
    expect(out.slice().sort((a, b) => a - b)).toEqual(input);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result order at each item's ORIGINAL index regardless of completion order", async () => {
    const items = [30, 10, 20];
    const out = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never runs more than `concurrency` items at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("one item throwing does not cancel or block the others", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 3, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });

  it("concurrency greater than item count runs them all without error", async () => {
    const out = await mapWithConcurrency([1, 2], 10, async (i) => i * 2);
    expect(out).toEqual([2, 4]);
  });

  it("empty input resolves to an empty array without calling fn", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 5, async () => {
      calls++;
      return 0;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("passes both item and its original index to fn", async () => {
    const seen: Array<[string, number]> = [];
    await mapWithConcurrency(["a", "b", "c"], 2, async (item, index) => {
      seen.push([item, index]);
      return null;
    });
    expect(seen.slice().sort((a, b) => a[1] - b[1])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});
