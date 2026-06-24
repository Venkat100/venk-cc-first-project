// AI Agent — autopilot cron endpoints (server-only, Phase 10.5).
//
// Two token-protected batch endpoints that run the agent for ALL eligible
// users without manual clicks. Identity is the service-role client + each
// agent's own user_id — NOT a JWT (there's no signed-in user during a cron).
//
//   • /api/cron/agent-thinker  — DAILY (Vercel Cron). Runs the real thinker for
//     every enabled agent with agent_cash > 0. Autonomous agents auto-trade;
//     approve-mode agents get a fresh PENDING proposal (the thinker decides
//     based on each agent's mode — see thinker.server.ts).
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
// RATE-LIMIT SAFETY (hardening #2): both loops price held symbols via Finnhub
// (60 req/min free tier). To stay safe + fast as the user base grows:
//   • Per-run DEDUP — the thinker batch fetches ONE universe snapshot and reuses
//     it for every agent; the watchdog batch fetches the UNION of held symbols
//     once and reuses it for every agent. Most agents share the same ~12 names,
//     so unique fetches stay tiny even with many users.
//   • A global limiter + retry/backoff + per-call timeout in finnhub.server.ts
//     keeps every Finnhub call under the cap and resilient (a stuck/failing
//     symbol is skipped, never hangs or aborts the batch).
// Next lever if needed: a durable Postgres price_cache (deferred since Phase 5).

import { serverEnv } from "@/lib/marketData/env.server";
import { providerQuotes, fhMetrics } from "@/lib/marketData/finnhub.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { prefetchUniverse, type UniverseData } from "./quant.server";
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
  proposalsTotal: number;
  results: Array<{ userId: string; ran: boolean; trades?: number; proposed?: boolean; reason?: string; error?: string }>;
  errors: string[];
};

// `onlyUserId` scopes the batch to one agent (on-demand / verification); omitted
// in production so the cron runs every eligible agent (BOTH modes — the thinker
// auto-trades autonomous agents and proposes for approve-mode agents).
export async function runThinkerForAllAgents(opts: { onlyUserId?: string; onlyUserIds?: string[]; prefetch?: UniverseData } = {}): Promise<ThinkerBatchSummary> {
  const admin = getServiceClient();
  const errors: string[] = [];
  let q = admin.from("agent_config").select("user_id").eq("enabled", true).gt("agent_cash", 0);
  if (opts.onlyUserId) q = q.eq("user_id", opts.onlyUserId);
  if (opts.onlyUserIds) q = q.in("user_id", opts.onlyUserIds);
  const { data: cfgs, error } = await q;
  if (error) throw new Error("read agent_config: " + error.message);

  // Price the universe ONCE for the whole batch (same data for every agent) and
  // reuse it — instead of every agent re-fetching the same ~12 symbols.
  const prefetch = (cfgs ?? []).length ? opts.prefetch ?? (await prefetchUniverse()) : undefined;

  const results: ThinkerBatchSummary["results"] = [];
  let tradesTotal = 0;
  let proposalsTotal = 0;
  for (const c of cfgs ?? []) {
    try {
      const r = await runThinker(c.user_id, { prefetch });
      const trades = r.executed?.length ?? 0;
      tradesTotal += trades;
      if (r.proposed) proposalsTotal += 1;
      results.push({ userId: c.user_id, ran: r.ran, trades, proposed: r.proposed, reason: r.ran ? undefined : r.reason });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "thinker failed";
      errors.push(`${c.user_id}: ${msg}`);
      results.push({ userId: c.user_id, ran: false, error: msg });
    }
  }
  return { ranAt: new Date().toISOString(), eligible: (cfgs ?? []).length, processed: results.filter((r) => r.ran).length, tradesTotal, proposalsTotal, results, errors };
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
export async function runWatchdogForAllAgents(opts: { onlyUserId?: string; onlyUserIds?: string[]; sources?: WatchdogSources; skipMarketCheck?: boolean } = {}): Promise<WatchdogBatchSummary> {
  const ranAt = new Date().toISOString();
  if (!opts.skipMarketCheck && !isUsMarketOpen()) {
    return { ranAt, marketOpen: false, skipped: true, eligible: 0, processed: 0, sellsTotal: 0, results: [], errors: [] };
  }

  const admin = getServiceClient();
  const errors: string[] = [];
  let cq = admin.from("agent_config").select("user_id").eq("enabled", true);
  if (opts.onlyUserId) cq = cq.eq("user_id", opts.onlyUserId);
  if (opts.onlyUserIds) cq = cq.in("user_id", opts.onlyUserIds);
  const { data: cfgs, error: cErr } = await cq;
  if (cErr) throw new Error("read agent_config: " + cErr.message);
  let hq = admin.from("agent_holdings").select("user_id, symbol");
  if (opts.onlyUserId) hq = hq.eq("user_id", opts.onlyUserId);
  if (opts.onlyUserIds) hq = hq.in("user_id", opts.onlyUserIds);
  const { data: holds, error: hErr } = await hq;
  if (hErr) throw new Error("read agent_holdings: " + hErr.message);

  const enabledUsers = new Set((cfgs ?? []).map((c) => c.user_id));
  const withHoldings = new Set((holds ?? []).map((h) => h.user_id));
  const eligible = (cfgs ?? []).filter((c) => withHoldings.has(c.user_id));

  // Build SHARED price + beta sources ONCE from the union of held symbols across
  // all eligible agents (most overlap on the same universe), so each agent's
  // watchdog reuses them instead of re-fetching. Verification may inject sources.
  let sources = opts.sources;
  if (!sources && eligible.length) {
    const symbols = Array.from(new Set((holds ?? []).filter((h) => enabledUsers.has(h.user_id)).map((h) => String(h.symbol).toUpperCase())));
    const quotes = await providerQuotes(symbols);
    const priceMap = new Map(quotes.filter((qt) => qt.price > 0).map((qt) => [qt.symbol, qt.price]));
    const betaMap = new Map<string, number>();
    await Promise.all(
      symbols.map(async (s) => {
        try {
          const m = await fhMetrics(s);
          if (m.beta && m.beta > 0) betaMap.set(s, m.beta);
        } catch {
          /* leave unset → watchdog defaults beta to 1 */
        }
      }),
    );
    sources = {
      prices: async (syms) => new Map(syms.filter((s) => priceMap.has(s)).map((s) => [s, priceMap.get(s)!])),
      betas: async (syms) => new Map(syms.filter((s) => betaMap.has(s)).map((s) => [s, betaMap.get(s)!])),
    };
  }

  const results: WatchdogBatchSummary["results"] = [];
  let sellsTotal = 0;
  for (const c of eligible) {
    try {
      const r = await runWatchdog(c.user_id, sources);
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
