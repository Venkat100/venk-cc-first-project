// Daily market brief — autopilot cron endpoint (server-only).
//
// 2026-08-19 (HANDOFF.md — full incident writeup there): this job used to
// run INSIDE /api/cron/agent-thinker, immediately after the thinker batch,
// because Vercel Hobby caps a project at 2 daily crons and both slots were
// already spoken for (agent-thinker, snapshot). That combination —
// 13 agents' worth of real Claude calls, then a second AI job on top,
// all inside Vercel Hobby's 300-second hard ceiling (confirmed via the real
// runtime log AND Vercel's own docs to be the plan's maximum, not a config
// left too low) — occasionally ran out of budget partway through this
// job's own per-user loop, silently. Two specific real users
// (pcvenky10, rajath.anil) missed their brief on both affected days.
//
// Fixed the same way the watchdog already sidesteps the 2-cron limit: this
// job now runs entirely on its own GitHub Actions schedule
// (.github/workflows/agent-brief.yml), completely OUT of the Vercel
// function's shared time budget — for zero additional cost, the same
// tradeoff already made for the watchdog. Auth mirrors every other
// CRON_SECRET-protected endpoint in this codebase (see
// lib/agent/cron.server.ts's authorizeCron, duplicated here rather than
// exported cross-module — three call sites, not worth a shared import for
// six lines).
//
// MAINTAINABILITY, stated plainly: this is now the THIRD separate
// scheduler running production jobs — Vercel Cron (agent-thinker,
// snapshot), GitHub Actions (agent-watchdog, and now this). Each exists for
// a real, specific reason (Vercel Hobby's 2-cron-per-day cap forced
// watchdog and now brief off-platform), not because splitting schedulers
// is good practice — three moving parts is a real ongoing cost (three
// places to check when something's wrong, three auth surfaces sharing one
// CRON_SECRET, three schedule definitions to keep straight) and should be
// consolidated onto one platform the day Vercel Pro removes the cron-count
// pressure that caused it, not left to grow to a fourth.

import { serverEnv } from "@/lib/marketData/env.server";
import { runDailyBriefs } from "./insights.server";
import { recordHeartbeat } from "@/lib/health/heartbeat.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function authorizeCron(request: Request): Response | null {
  const expected = serverEnv("CRON_SECRET");
  if (!expected) return json({ ok: false, error: "CRON_SECRET is not configured on the server." }, 500);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret") || new URL(request.url).searchParams.get("secret") || "";
  if (provided !== expected) return json({ ok: false, error: "Unauthorized." }, 401);
  return null;
}

export async function handleDailyBriefRequest(request: Request): Promise<Response> {
  const denied = authorizeCron(request);
  if (denied) return denied;
  try {
    const summary = await runDailyBriefs();
    await recordHeartbeat("daily-brief", "ok", { briefsWritten: summary.briefsWritten, skipped: summary.skipped, usersConsidered: summary.usersConsidered });
    return json({ ok: true, summary }, 200);
  } catch (e) {
    await recordHeartbeat("daily-brief", "error", { error: e instanceof Error ? e.message : String(e) });
    return json({ ok: false, error: e instanceof Error ? e.message : "Daily brief job failed." }, 500);
  }
}
