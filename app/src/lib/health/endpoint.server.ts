// Token-protected HTTP handler for /api/health (PLAN.md §6 step 5, part
// A3). Same CRON_SECRET auth as /api/cron/* — a health endpoint that
// reveals DB/provider/cron internals is itself worth keeping non-public,
// and reusing the existing secret means one fewer credential to manage.
//
// Returns 200 when every check passes, 503 (standard "service degraded"
// for uptime monitors to alert on) when any check fails — never 500, since
// an unhealthy dependency is an expected, well-formed response here, not a
// crash of the health endpoint itself.

import * as Sentry from "@sentry/node";
import { serverEnv } from "@/lib/marketData/env.server";
import { captureServerError } from "@/lib/sentry/server";
import { runHealthChecks } from "./check.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * POST /api/health?action=test-sentry — deliberately captures a marker
 * error through the SAME captureServerError() every real production error
 * seam calls (start.ts middleware, server.ts catch-all), then flushes and
 * returns the Sentry event id, so "is error monitoring actually alive
 * right now" is a repeatable check against the real deployed environment,
 * not a one-time proof that can go stale the moment the DSN changes again.
 * Same CRON_SECRET auth as the GET report below — this is diagnostic
 * surface, not a public endpoint.
 */
async function handleTestSentry(): Promise<Response> {
  const configured = !!serverEnv("SENTRY_DSN");
  if (!configured) {
    return json({ ok: false, sentryConfigured: false, error: "SENTRY_DSN is not set — nothing to test. See the config section of a normal GET /api/health for the standing visibility check." }, 200);
  }
  const marker = `health-endpoint-test-sentry-${Date.now()}`;
  const eventId = captureServerError(new Error(`[api/health] deliberate test error — marker=${marker}`), { route: "/api/health", action: "test-sentry", marker });
  const flushed = await Sentry.flush(5000);
  return json({ ok: !!eventId && flushed, sentryConfigured: true, eventId, marker, flushed }, 200);
}

export async function handleHealthRequest(request: Request): Promise<Response> {
  const expected = serverEnv("CRON_SECRET");
  if (!expected) return json({ ok: false, error: "CRON_SECRET is not configured on the server." }, 500);

  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret") || url.searchParams.get("secret") || "";

  if (provided !== expected) return json({ ok: false, error: "Unauthorized." }, 401);

  if (request.method === "POST" && url.searchParams.get("action") === "test-sentry") {
    return handleTestSentry();
  }

  const report = await runHealthChecks();
  return json(report, report.ok ? 200 : 503);
}
