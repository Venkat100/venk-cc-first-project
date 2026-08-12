// Shared verification-script harness.
//
// ROOT-CAUSED, repeatedly (10.4 snapshots, the Insights brief, M1 margin,
// and 2026-08-11's scenario-challenges debug script — the last one hung
// SILENTLY for ~2 hours with zero output because it was hand-rolled and
// skipped every one of these protections): a bare, unwrapped `await` on a
// stalled network call has nothing to convert it into a rejection, and an
// uncaught top-level throw does NOT reliably exit a vite-node process the
// way plain Node does. Every verify-*.ts script — INCLUDING throwaway ad
// hoc debug scripts written under time pressure — MUST route through this
// module rather than re-implementing (or, under pressure, skipping) these
// primitives by hand. That's the whole point: the protection can't be
// "forgotten" if it isn't something to remember in the first place.
//
// Usage:
//   import { step, assert, approx, runVerification } from "./verify-harness";
//   async function main() {
//     const x = await step("do a thing", () => someAsyncCall(), 20000);
//     assert("x is 5", x === 5);
//   }
//   runVerification(main, { cleanup: async () => { ...delete test users... } });

export function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Races `p` against a timer — never leaves an unbounded await in a script. */
export function withTimeout<T>(label: string, p: Promise<T>, ms = 20000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`STEP TIMEOUT after ${ms}ms: ${label}`)), ms))]);
}

/** One timestamped, timeout-bounded step. Prints before AND after, so a
 *  hang's last log line always tells you exactly which step it died in —
 *  the single biggest diagnostic gap in every past incident. */
export async function step<T>(label: string, fn: () => Promise<T>, ms = 20000): Promise<T> {
  console.log(`  [${ts()}] → ${label}`);
  const result = await withTimeout(label, fn(), ms);
  console.log(`  [${ts()}] ✓ ${label}`);
  return result;
}

let _failures = 0;
export function resetFailures(): void {
  _failures = 0;
}
export function failureCount(): number {
  return _failures;
}
export function assert(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) _failures++;
}
export function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

/** Deep VALUE equality — unlike `JSON.stringify(a) === JSON.stringify(b)`,
 *  this doesn't false-positive-fail on key order. Needed for anything
 *  round-tripped through a Postgres `jsonb` column: jsonb does not preserve
 *  key insertion order (confirmed 2026-08-11 investigating a scenario-
 *  challenges test failure — every field survived a round-trip correctly,
 *  only the serialized key order changed, which broke a naive
 *  JSON.stringify comparison). Use this for any jsonb-backed comparison. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The ONLY way any verify-*.ts script should create a throwaway test user.
 *
 * ROOT-CAUSED 2026-08-11: `handle_new_user()` (0022_terms_acceptance.sql)
 * REQUIRES `user_metadata.terms_accepted_version` and RAISE EXCEPTIONs
 * mid-transaction if it's missing — by design, so a bug in the real signup
 * form fails loudly instead of quietly creating an unconsented account. But
 * for a `createUser` caller, a trigger exception surfaces as an OPAQUE
 * Postgres/GoTrue 500 (`AuthRetryableFetchError`, empty message) — nothing
 * about it says "you forgot the metadata." A throwaway debug script written
 * by hand (calling `admin.auth.admin.createUser` directly instead of
 * through this helper) hit exactly that and was first misdiagnosed as a
 * Supabase platform outage. Every one of the ~20 existing verify-*.ts call
 * sites already had the field — the gap was entirely in ad hoc scripts that
 * didn't copy that pattern. Routing through this helper makes forgetting it
 * structurally impossible rather than something to remember per script.
 */
export async function createTestUser(
  admin: { auth: { admin: { createUser: (args: unknown) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } },
  email: string,
  password: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<{ uid: string; email: string }> {
  const res = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { terms_accepted_version: "test-harness", ...extraMetadata },
  });
  if (res.error || !res.data.user) {
    throw new Error(`createTestUser(${email}) failed: ${res.error?.message ?? "no user returned"}`);
  }
  return { uid: res.data.user.id, email };
}

/**
 * Wraps a verification script's ENTIRE body. This is the structural
 * backstop for the exact failure mode this module exists to prevent: even
 * a script that forgets to wrap one particular await in `step()` still
 * cannot hang past `globalTimeoutMs` — the whole `main()` call is itself
 * raced against one hard ceiling, independent of any per-step timeout.
 * Also enforces the whole-body try/catch + explicit process.exit rule (never
 * rely on vite-node to exit on an uncaught throw — it doesn't) and always
 * runs `cleanup` (e.g. deleting throwaway test users), success or failure.
 */
export async function runVerification(main: () => Promise<void>, opts: { globalTimeoutMs?: number; cleanup?: () => Promise<void> } = {}): Promise<never> {
  const globalTimeoutMs = opts.globalTimeoutMs ?? 8 * 60_000;
  try {
    await withTimeout("ENTIRE SCRIPT (global ceiling — the structural backstop)", main(), globalTimeoutMs);
    if (opts.cleanup) await withTimeout("cleanup", opts.cleanup(), 30_000);
    console.log(`\n${_failures === 0 ? "ALL CHECKS PASSED ✅" : `${_failures} CHECK(S) FAILED ❌`}`);
    process.exit(_failures === 0 ? 0 : 1);
  } catch (e) {
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? (e.stack ?? e.message) : e);
    if (opts.cleanup) {
      try {
        await withTimeout("cleanup (after failure)", opts.cleanup(), 30_000);
      } catch (cleanupErr) {
        console.error(`[${ts()}] cleanup ALSO failed:`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      }
    }
    process.exit(1);
  }
}
