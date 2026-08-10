// Token-protected HTTP handler for /api/health (PLAN.md §6 step 5, part
// A3). Same CRON_SECRET auth as /api/cron/* — a health endpoint that
// reveals DB/provider/cron internals is itself worth keeping non-public,
// and reusing the existing secret means one fewer credential to manage.
//
// Returns 200 when every check passes, 503 (standard "service degraded"
// for uptime monitors to alert on) when any check fails — never 500, since
// an unhealthy dependency is an expected, well-formed response here, not a
// crash of the health endpoint itself.

import { serverEnv } from "@/lib/marketData/env.server";
import { runHealthChecks } from "./check.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleHealthRequest(request: Request): Promise<Response> {
  const expected = serverEnv("CRON_SECRET");
  if (!expected) return json({ ok: false, error: "CRON_SECRET is not configured on the server." }, 500);

  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret") || url.searchParams.get("secret") || "";

  if (provided !== expected) return json({ ok: false, error: "Unauthorized." }, 401);

  const report = await runHealthChecks();
  return json(report, report.ok ? 200 : 503);
}
