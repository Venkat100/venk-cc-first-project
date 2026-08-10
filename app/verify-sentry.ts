// Live Sentry delivery verification (PLAN.md §6 step 5, part A3). Real
// DSN, real network delivery to Sentry's ingest servers — no mocks.
// Deliberately throws a marker error with rich-but-safe debug context,
// captures it via the SAME captureServerError() every real server-error
// seam (start.ts middleware, server.ts catch-all) calls, then flushes and
// reports the returned event ID so it can be independently confirmed in
// the Sentry dashboard. Also asserts (before sending) that the context
// object contains none of this app's known secret shapes.

import * as Sentry from "@sentry/node";
import { captureServerError } from "@/lib/sentry/server";
import { serverEnv } from "@/lib/marketData/env.server";

let failures = 0;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function ts() {
  return new Date().toISOString().slice(11, 23);
}

async function main() {
  console.log("\n████ 0. Confirm the DSN is actually configured (not a silent no-op) ████");
  const dsn = serverEnv("SENTRY_DSN");
  assert("SENTRY_DSN is set in the server environment", !!dsn, dsn ? `${dsn.slice(0, 30)}…` : "MISSING");
  if (!dsn) throw new Error("SENTRY_DSN not configured — cannot verify live delivery.");

  console.log("\n████ 1. Build a marker error with realistic-but-safe debug context ████");
  const marker = `sentry-verify-${Date.now()}`;
  const testError = new Error(`[verify-sentry] deliberate test error — marker=${marker}`);
  const context = {
    userId: "00000000-0000-0000-0000-000000000000", // fake, not a real user
    route: "/api/cron/agent-thinker",
    action: "runAgentThinkerFn",
    marker,
  };
  console.log(`  error message: ${testError.message}`);
  console.log(`  context: ${JSON.stringify(context)}`);

  // Defense-in-depth self-check: this is exactly the discipline
  // lib/sentry/server.ts's header commits to (never pass secrets/tokens)
  // — verify the context we're ABOUT to send contains none of this app's
  // known secret shapes before it ever leaves the process.
  const SECRET_PATTERNS = [/sk-ant-/i, /accessToken/i, /service_role/i, /Bearer /i, /supabase\.co.*key/i];
  const blob = JSON.stringify(context);
  for (const pat of SECRET_PATTERNS) {
    assert(`context does NOT match secret-shaped pattern ${pat}`, !pat.test(blob));
  }

  console.log("\n████ 2. Capture + flush — real network delivery to Sentry's ingest servers ████");
  const lastEventId = captureServerError(testError, context);
  console.log(`  [${ts()}] captured, Sentry event id: ${lastEventId}`);
  assert("an event id was generated (capture actually ran, not a silent no-op)", !!lastEventId, String(lastEventId));

  console.log(`  [${ts()}] → flushing (waiting for network delivery confirmation, up to 5s)`);
  const flushed = await Sentry.flush(5000);
  console.log(`  [${ts()}] ✓ flush returned: ${flushed}`);
  assert("Sentry.flush() reported successful delivery to the ingest server", flushed === true, `flushed=${flushed}`);

  console.log("\n████ RESULT ████");
  console.log(`  Event ID to look up in the Sentry dashboard: ${lastEventId}`);
  console.log(`  Marker to search for: ${marker}`);
  console.log(`  Expected in the dashboard: message contains "${marker}", extra context shows userId/route/action as above.`);
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(`\n[${ts()}] FATAL:`, e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  });
