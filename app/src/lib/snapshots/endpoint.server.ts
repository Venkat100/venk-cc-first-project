// Token-protected HTTP handler for the snapshot writer. Wired into the server
// entry at /api/cron/snapshot. Vercel Cron calls it daily in Phase 9; for now
// it's triggered manually for testing.
//
// Auth: requires the CRON_SECRET, supplied as `Authorization: Bearer <secret>`,
// `x-cron-secret: <secret>`, or `?secret=<secret>`. Missing/wrong → 401.

import { serverEnv } from "@/lib/marketData/env.server";
import { runSnapshots } from "./writer.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleSnapshotRequest(request: Request): Promise<Response> {
  const expected = serverEnv("CRON_SECRET");
  if (!expected) return json({ ok: false, error: "CRON_SECRET is not configured on the server." }, 500);

  const url = new URL(request.url);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret") || url.searchParams.get("secret") || "";

  if (provided !== expected) return json({ ok: false, error: "Unauthorized." }, 401);

  try {
    const summary = await runSnapshots();
    return json({ ok: true, summary }, 200);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Snapshot run failed." }, 500);
  }
}
