// Local half of the config-drift check (2026-08-18/19 — HANDOFF.md). A
// fingerprint reported by /api/health is useless without something to
// compare it to; this computes the SAME fingerprints from app/.env's local
// values (via the SAME computeFingerprints() check.server.ts uses, so the
// two can never diverge by accident), diffs them against what the live
// deployment currently reports, and prints a per-secret line meant to be
// scanned in three seconds, not studied.
//
// Distinguishes "differs as designed" (ANTHROPIC_API_KEY is deliberately
// papertrader-dev locally / papertrader-prod in production — see
// fingerprint.ts's EXPECTED_PER_ENVIRONMENT_VARS) from "differs
// unexpectedly" (a real problem) — without that distinction this script
// would report a permanent, correct, and therefore IGNORABLE mismatch on
// ANTHROPIC_API_KEY every single run, forever, training the reader to stop
// reading it. A variable declared expected-per-environment is STILL
// required to be present on both sides — "expected to differ in value"
// never means "expected to be missing" (fingerprint.ts's diffFingerprints
// enforces this; this script just renders whatever it decides).
//
// Usage:
//   npm run check-config
//   PRODUCTION_HEALTH_URL=https://staging.example.com npm run check-config
import { serverEnv, requireServerEnv } from "@/lib/marketData/env.server";
import { computeFingerprints, diffFingerprints, isDriftProblem, isExpectedPerEnvironment, type FingerprintMap, type FingerprintDiffRow } from "@/lib/health/fingerprint";
import { step, assert, runVerification } from "./verify-harness";

const PRODUCTION_HEALTH_URL = process.env.PRODUCTION_HEALTH_URL || "https://mypapertrader.com/api/health";

function describe(row: FingerprintDiffRow): string {
  switch (row.status) {
    case "match":
      return "match";
    case "expected_divergent":
      return "present in both — values differ by design (per-environment)";
    case "unexpected_mismatch":
      return "UNEXPECTED MISMATCH — should be identical, isn't";
    case "remote_missing":
      return isExpectedPerEnvironment(row.name)
        ? "MISSING IN PRODUCTION — expected to differ in VALUE, never to be absent"
        : "MISSING IN PRODUCTION";
    case "local_missing":
      return "MISSING LOCALLY (set in production, not in app/.env)";
    case "both_missing":
      return "MISSING EVERYWHERE";
  }
}

async function main() {
  const cronSecret = requireServerEnv("CRON_SECRET");

  const local = computeFingerprints(serverEnv);

  console.log(`\n████ Fetching production's reported fingerprints (${PRODUCTION_HEALTH_URL}) ████`);
  const remote = await step("GET /api/health", async () => {
    const res = await fetch(PRODUCTION_HEALTH_URL, { headers: { authorization: `Bearer ${cronSecret}` } });
    if (res.status === 401) {
      throw new Error("401 Unauthorized — local CRON_SECRET doesn't match production's. That mismatch IS a drift finding on its own: fix CRON_SECRET first, then re-run this to check the rest.");
    }
    // 503 is a valid, well-formed response from this endpoint (see
    // endpoint.server.ts's own header) — it means some OTHER check failed
    // (database/market-data/cron freshness), not that config.secrets is
    // missing or unusable. Only reject genuinely unexpected statuses.
    if (res.status !== 200 && res.status !== 503) throw new Error(`unexpected status ${res.status}`);
    const body = (await res.json()) as { config?: { secrets?: FingerprintMap } };
    if (!body.config?.secrets) throw new Error("response has no config.secrets — is production running the version of the code that reports fingerprints?");
    return body.config.secrets;
  });

  console.log("\n████ Config drift — local app/.env vs. production ████");
  const rows = diffFingerprints(local, remote);
  for (const row of rows) {
    assert(`${row.name.padEnd(26)} ${describe(row)}`, !isDriftProblem(row.status), `local=${row.local ?? "unset"} remote=${row.remote ?? "unset"}`);
  }

  const matches = rows.filter((r) => r.status === "match").length;
  const expectedDivergent = rows.filter((r) => r.status === "expected_divergent").length;
  const problems = rows.filter((r) => isDriftProblem(r.status)).length;
  console.log(
    `\nSUMMARY: ${rows.length}/${rows.length} checked — ${matches} match${matches === 1 ? "" : "es"}, ${expectedDivergent} intentionally per-environment (confirmed present in both)${
      problems > 0 ? `, ${problems} UNEXPECTED PROBLEM${problems === 1 ? "" : "S"}` : ", no unexpected drift"
    }.`,
  );
}

runVerification(main, { globalTimeoutMs: 30_000 });
