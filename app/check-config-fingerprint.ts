// Local half of the config-drift check (2026-08-18 — HANDOFF.md). A
// fingerprint reported by /api/health is useless without something to
// compare it to; this computes the SAME fingerprints from app/.env's local
// values (via the SAME computeFingerprints() check.server.ts uses, so the
// two can never diverge by accident) and diffs them against what the live
// deployment currently reports — turning "opaque hash string" into a
// visible ✅ match / ❌ mismatch per secret.
//
// Usage:
//   npm run check-config
//   PRODUCTION_HEALTH_URL=https://staging.example.com npm run check-config
import { serverEnv, requireServerEnv } from "@/lib/marketData/env.server";
import { computeFingerprints, diffFingerprints, type FingerprintMap } from "@/lib/health/fingerprint";
import { step, assert, runVerification } from "./verify-harness";

const PRODUCTION_HEALTH_URL = process.env.PRODUCTION_HEALTH_URL || "https://mypapertrader.com/api/health";

async function main() {
  const cronSecret = requireServerEnv("CRON_SECRET");

  console.log("\n████ Local fingerprints (from app/.env) ████");
  const local = computeFingerprints(serverEnv);
  for (const [name, fp] of Object.entries(local)) console.log(`  ${name}: ${fp ?? "(not set locally)"}`);

  console.log(`\n████ Fetching production's reported fingerprints (${PRODUCTION_HEALTH_URL}) ████`);
  const remote = await step("GET /api/health", async () => {
    const res = await fetch(PRODUCTION_HEALTH_URL, { headers: { authorization: `Bearer ${cronSecret}` } });
    if (res.status === 401) {
      throw new Error("401 Unauthorized — local CRON_SECRET doesn't match production's. That mismatch IS a drift finding on its own: fix CRON_SECRET first, then re-run this to check the rest.");
    }
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
    const body = (await res.json()) as { config?: { secrets?: FingerprintMap } };
    if (!body.config?.secrets) throw new Error("response has no config.secrets — is production running the version of the code that reports fingerprints?");
    return body.config.secrets;
  });

  console.log("\n████ Diff ████");
  const rows = diffFingerprints(local, remote);
  for (const row of rows) {
    assert(`${row.name}: local and production agree`, row.status === "match" || row.status === "both-missing", `${row.status} (local=${row.local ?? "unset"} remote=${row.remote ?? "unset"})`);
  }
}

runVerification(main, { globalTimeoutMs: 30_000 });
