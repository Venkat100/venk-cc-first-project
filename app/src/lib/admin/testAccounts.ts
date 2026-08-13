// Test-account detection for the admin console (2026-08-13 app audit,
// Part 5/6): analytics/usage figures were previously unable to distinguish
// real users from throwaway verify-script accounts, making every usage
// number (e.g. "213 signups") meaningless without out-of-band context —
// 213 signup events but only 6 distinct real users, the rest belonging to
// accounts created and deleted by verify-*.ts runs during this build.
//
// Current verify-*.ts / verify-harness.ts createTestUser() calls all use
// `@example.org`. But a live check against the real account list during
// this fix (tmp-fixpass-verify-accountcounts.ts) found 5 leftover
// `pt-*@example.com` throwaway accounts from an earlier project phase,
// predating the .org convention — proof a single-domain check
// undercounts. `example.com`, `example.net`, and `example.org` are ALL
// reserved-for-documentation TLDs under RFC 2606, so matching all three
// stays zero-false-positive (no legitimate signup can ever use any of
// them) while covering both the current and historical test-account shape.
//
// A boolean column (e.g. profiles.is_test_account) was considered and
// rejected for this pass: it would need backfilling for the ~200 already-
// deleted throwaway rows still referenced by analytics_events (their
// profile no longer exists to carry a flag), while this email-pattern
// check works identically for past and future data with no migration.
const TEST_ACCOUNT_DOMAINS = ["@example.org", "@example.com", "@example.net"];

export function isTestAccountEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return TEST_ACCOUNT_DOMAINS.some((d) => lower.endsWith(d));
}
