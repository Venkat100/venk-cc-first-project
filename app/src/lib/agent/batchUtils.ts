// Pure batch-processing helpers for the agent-thinker cron (2026-08-19 —
// HANDOFF.md incident: two specific real users, pcvenky10 and rajath.anil,
// missed their daily brief on both days a 300-second platform timeout was
// hit — not because they were unlucky, but because a stable, unshuffled
// query order meant whoever sat at the end of the queue was ALWAYS first to
// be cut. Fixed here, not just incidentally by parallelizing: shuffle so
// the cost of any future partial run lands on different people each time,
// and bound concurrency so the whole batch finishes faster in the first
// place. No I/O — pure and cheaply testable, same pattern as
// activityStatus.ts/fingerprint.ts elsewhere in this codebase.

/** Fisher-Yates — uniform, in-place-free (returns a new array), swap `rng`
 *  for a seeded generator in tests to make shuffling itself deterministic
 *  without weakening real-run randomness. */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Runs `fn` over every item with at most `concurrency` in flight at once —
 * a bounded worker pool, not `Promise.all` (which would fire everything at
 * once) and not a sequential loop (which is what let the queue tail
 * starve). Preserves each result at its ORIGINAL index regardless of
 * completion order, so callers can still line results up with `items`.
 * One item throwing does not cancel the others — same isolation the
 * existing per-agent try/catch already relied on, just generalized here so
 * every caller of this helper gets it for free.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
