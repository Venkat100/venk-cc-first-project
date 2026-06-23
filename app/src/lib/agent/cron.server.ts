// AI Agent — autopilot cron endpoints (server-only, Phase 10.5).
//
// Two token-protected batch endpoints that run the agent for ALL eligible
// users without manual clicks. Identity is the service-role client + each
// agent's own user_id — NOT a JWT (there's no signed-in user during a cron).
//
//   • /api/cron/agent-thinker  — DAILY (Vercel Cron). Runs the real thinker for
//     every agent that is enabled AND mode='autonomous' AND agent_cash > 0.
//     mode='approve' agents are intentionally SKIPPED (see TODO below).
//   • /api/cron/agent-watchdog — INTRADAY (GitHub Actions, a few times during US
//     market hours, since Vercel Hobby cron runs at most once/day). Runs the
//     real watchdog for every enabled agent that holds positions. No-ops cheaply
//     when the US market is closed.
//
// Auth mirrors /api/cron/snapshot: require the CRON_SECRET via
// `Authorization: Bearer <secret>` (Vercel Cron auto-sends it), `x-cron-secret`,
// or `?secret=`. Per-agent errors are isolated so one failure can't abort the
// batch. Both return a JSON summary.
//
// TODO (approve mode): autonomous agents auto-trade here; approve-mode agents
// should instead generate *proposals* for the user to confirm. Not built yet —
// for now they're simply not auto-traded.
//
// SCALING CAVEAT (hardening, not solved here): the thinker makes one LLM call
// per autonomous agent per run (fine), but both loops price held symbols via
// Finnhub (60 req/min free tier). We run agents SEQUENTIALLY (natural pacing)
// rather than in parallel, but as the user base grows this will need real
// throttling / a shared price cache / batched quotes. Logged in HANDOFF.

import { serverEnv } from "@/lib/marketData/env.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { runThinker } from "./thinker.server";
import { runWatchdog, type WatchdogSources } from "./watchdog.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Shared CRON_SECRET check. Returns null when authorized, else a 401/500 Response. */
function authorizeCron(request: Request): Response | null {
  const expected = serverEnv("CRON_SECRET");
  if (!expected) return json({ ok: false, error: "CRON_SECRET is not configured on the server." }, 500);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret") || new URL(request.url).searchParams.get("secret") || "";
  if (provided !== expected) return json({ ok: false, error: "Unauthorized." }, 401);
  return null;
}

/** US equity regular session: Mon–Fri, 9:30–16:00 America/New_York (DST-aware
 *  via Intl). Holidays are not excluded — off-day pings just no-op cheaply. */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (hour === 24) hour = 0; // some runtimes render midnight as "24"
  if (weekday === "Sat" || weekday === "Sun") return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export type ThinkerBatchSummary = {
  ranAt: string;
  eligible: number;
  processed: number;
  tradesTotal: number;
  results: Array<{ userId: string; ran: boolean; trades?: number; reason?: string; error?: string }>;
  errors: string[];
};

// `onlyUserId` scopes the batch to one agent (on-demand / verification); omitted
// in production so the cron runs every eligible agent.
export async function runThinkerForAllAgents(opts: { onlyUserId?: string } = {}): Promise<ThinkerBatchSummary> {
  const admin = getServiceClient();
  const errors: string[] = [];
  let q = admin.from("agent_config").select("user_id").eq("enabled", true).eq("mode", "autonomous").gt("agent_cash", 0);
  if (opts.onlyUserId) q = q.eq("user_id", opts.onlyUserId);
  const { data: cfgs, error } = await q;
  if (error) throw new Error("read agent_config: " + error.message);

  const results: ThinkerBatchSummary["results"] = [];
  let tradesTotal = 0;
  for (const c of cfgs ?? []) {
    try {
      const r = await runThinker(c.user_id);
      const trades = r.executed?.length ?? 0;
      tradesTotal += trades;
      results.push({ userId: c.user_id, ran: r.ran, trades, reason: r.ran ? undefined : r.reason });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "thinker failed";
      errors.push(`${c.user_id}: ${msg}`);
      results.push({ userId: c.user_id, ran: false, error: msg });
    }
  }
  return { ranAt: new Date().toISOString(), eligible: (cfgs ?? []).length, processed: results.filter((r) => r.ran).length, tradesTotal, results, errors };
}

export type WatchdogBatchSummary = {
  ranAt: string;
  marketOpen: boolean;
  skipped?: boolean;
  eligible: number;
  processed: number;
  sellsTotal: number;
  results: Array<{ userId: string; ran: boolean; checked?: number; sells?: number; ratchets?: number; reason?: string; error?: string }>;
  errors: string[];
};

// `sources`/`skipMarketCheck`/`onlyUserId` exist only for verification; production
// calls with no args (real market gate, real quote sources, every eligible agent).
export async function runWatchdogForAllAgents(opts: { onlyUserId?: string; sources?: WatchdogSources; skipMarketCheck?: boolean } = {}): Promise<WatchdogBatchSummary> {
  const ranAt = new Date().toISOString();
  if (!opts.skipMarketCheck && !isUsMarketOpen()) {
    return { ranAt, marketOpen: false, skipped: true, eligible: 0, processed: 0, sellsTotal: 0, results: [], errors: [] };
  }

  const admin = getServiceClient();
  const errors: string[] = [];
  let cq = admin.from("agent_config").select("user_id").eq("enabled", true);
  if (opts.onlyUserId) cq = cq.eq("user_id", opts.onlyUserId);
  const { data: cfgs, error: cErr } = await cq;
  if (cErr) throw new Error("read agent_config: " + cErr.message);
  const { data: holds, error: hErr } = await admin.from("agent_holdings").select("user_id");
  if (hErr) throw new Error("read agent_holdings: " + hErr.message);

  const withHoldings = new Set((holds ?? []).map((h) => h.user_id));
  const eligible = (cfgs ?? []).filter((c) => withHoldings.has(c.user_id));

  const results: WatchdogBatchSummary["results"] = [];
  let sellsTotal = 0;
  for (const c of eligible) {
    try {
      const r = await runWatchdog(c.user_id, opts.sources);
      sellsTotal += r.sells ?? 0;
      results.push({ userId: c.user_id, ran: r.ran, checked: r.checked, sells: r.sells, ratchets: r.ratchets, reason: r.ran ? undefined : r.reason });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "watchdog failed";
      errors.push(`${c.user_id}: ${msg}`);
      results.push({ userId: c.user_id, ran: false, error: msg });
    }
  }
  return { ranAt, marketOpen: true, eligible: eligible.length, processed: results.filter((r) => r.ran).length, sellsTotal, results, errors };
}

export async function handleAgentThinkerRequest(request: Request): Promise<Response> {
  const denied = authorizeCron(request);
  if (denied) return denied;
  try {
    return json({ ok: true, summary: await runThinkerForAllAgents() }, 200);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Agent thinker batch failed." }, 500);
  }
}

export async function handleAgentWatchdogRequest(request: Request): Promise<Response> {
  const denied = authorizeCron(request);
  if (denied) return denied;
  try {
    return json({ ok: true, summary: await runWatchdogForAllAgents() }, 200);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Agent watchdog batch failed." }, 500);
  }
}
