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
//
// 2026-08-19 INCIDENT (HANDOFF.md — full writeup there): this endpoint used
// to ALSO run the daily market brief (runDailyBriefs) after the thinker
// batch, then write the "agent-thinker" heartbeat last. Vercel Hobby's
// function duration cap — 300 seconds, confirmed via the real runtime log
// AND Vercel's own docs to be the plan's hard maximum, not a config left
// too low — was being hit during the brief loop, after the thinker batch
// itself had already finished. Two consequences, both fixed here:
//   1. The heartbeat, sitting after BOTH jobs, went stale even on days the
//      thinker batch itself completed cleanly — a false "the agent isn't
//      running" signal pointing at the wrong job.
//   2. The brief loop is per-user, not atomic — a kill mid-loop meant SOME
//      real users got their brief and others didn't, silently, no error
//      anywhere. Worse: the loop order was NOT shuffled, so the users at
//      the end of a stable query order were ALWAYS the ones cut, every
//      time the budget ran short — not "some users occasionally miss out,"
//      but "these specific users lose out systematically."
// Fixed: the daily brief now runs entirely separately, on its own GitHub
// Actions schedule (lib/insights/cron.server.ts — the SAME pattern the
// watchdog already uses, for the same reason: take it out of the shared
// Vercel budget entirely, at zero additional cost). This endpoint now ONLY
// runs the thinker batch, writes ITS OWN heartbeat immediately after ITS
// OWN work completes (never gated behind an unrelated job again — see
// batchUtils.ts's header for the general principle), and shuffles + bounds
// concurrency so a future budget squeeze (a much larger user base) doesn't
// silently reproduce the same "always the same people" unfairness.

import { serverEnv } from "@/lib/marketData/env.server";
import { providerQuotes, fhMetrics } from "@/lib/marketData/finnhub.server";
import { getServiceClient } from "@/lib/supabase/admin.server";
import { shuffle, mapWithConcurrency } from "./batchUtils";
import { prefetchUniverse, type UniverseData } from "./quant.server";
import { runThinker } from "./thinker.server";
import { runWatchdog, type WatchdogSources } from "./watchdog.server";
import { runMarginMonitor } from "@/lib/margin/monitor.server";
import { isUsMarketOpen } from "@/lib/marketData/marketHours";
import { recordHeartbeat } from "@/lib/health/heartbeat.server";
import { track } from "@/lib/analytics/track.server";

// Re-exported for backward compatibility — the actual definition moved to
// lib/marketData/marketHours.ts (PLAN.md §6 step 3) so the client-side live-
// price polling gate can share the SAME DST-aware check as this cron, rather
// than risking two copies drifting apart.
export { isUsMarketOpen };

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

export type ThinkerBatchSummary = {
  ranAt: string;
  eligible: number;
  processed: number;
  tradesTotal: number;
  proposalsTotal: number;
  results: Array<{ userId: string; ran: boolean; trades?: number; proposed?: boolean; reason?: string; error?: string }>;
  errors: string[];
};

// Bounded concurrency for the per-agent thinker loop (2026-08-19 incident —
// see this file's header). Justified against all three real ceilings that
// apply, not assumed:
//   - Claude: even the lowest published tier (platform.claude.com/docs/en/
//     api/rate-limits, checked 2026-08-19) is 1,000 requests/minute for the
//     Sonnet family. 5 concurrent agent calls is <0.5% of that floor —
//     effectively unconstrained at this scale.
//   - Finnhub, via our OWN global limiter (lib/marketData/ratelimit.server.ts
//     -- new RateLimiter(50, 6) in finnhub.server.ts): 50 starts/60s window,
//     6 concurrent in flight, process-wide. The universe scan is ONE shared
//     prefetch, not per-agent, so concurrency here only affects the rare
//     per-agent "held symbol missing from the scan" fallback fetch. Worst
//     case — every one of 5 concurrent agents needing that fallback at once
//     — is 5 concurrent Finnhub requests, still under the limiter's own
//     6-concurrent cap, leaving 1 slot of headroom for whatever else in the
//     process (watchdog, insights) might be running at the same moment.
//   - Our own per-user abuse guard (lib/rateLimit/check.server.ts's
//     RATE_LIMITS.agentRun, 3/5min, 20/day): does NOT apply here at all —
//     it's called only from the manual "Run agent now" button
//     (lib/agent/functions.ts); grep this file, it's never called from the
//     cron path, by design (the system's own scheduled action isn't a
//     per-user abuse case). Not a constraint, but worth stating precisely
//     rather than leaving which limiter applies ambiguous.
// 5 is therefore chosen for real, measured wall-clock benefit (roughly a
// 5x reduction versus fully sequential, see HANDOFF.md's before/after
// timing) while sitting comfortably under the one ceiling that's actually
// close enough to matter (Finnhub's concurrency cap), not for headroom
// that was never at risk (Claude).
const THINKER_CONCURRENCY = 5;

// `onlyUserId` scopes the batch to one agent (on-demand / verification); omitted
// in production so the cron runs every eligible agent (BOTH modes — the thinker
// auto-trades autonomous agents and proposes for approve-mode agents).
// `concurrency` overrides THINKER_CONCURRENCY — test-support only (real
// production calls never pass it), so thinker-concurrency-timing.ts can
// measure multiple bounds against the SAME real agents without needing a
// second code path.
export async function runThinkerForAllAgents(opts: { onlyUserId?: string; onlyUserIds?: string[]; prefetch?: UniverseData; concurrency?: number } = {}): Promise<ThinkerBatchSummary> {
  const admin = getServiceClient();
  let q = admin.from("agent_config").select("user_id").eq("enabled", true).gt("agent_cash", 0);
  if (opts.onlyUserId) q = q.eq("user_id", opts.onlyUserId);
  if (opts.onlyUserIds) q = q.in("user_id", opts.onlyUserIds);
  const { data: cfgs, error } = await q;
  if (error) throw new Error("read agent_config: " + error.message);

  // Price the universe ONCE for the whole batch (same data for every agent) and
  // reuse it — instead of every agent re-fetching the same ~12 symbols.
  const prefetch = (cfgs ?? []).length ? opts.prefetch ?? (await prefetchUniverse()) : undefined;

  // Fair-by-construction (2026-08-19 incident): a stable, unshuffled query
  // order meant that under budget pressure, the SAME agents (whoever's
  // last) always paid the cost. Shuffling the queue before processing means
  // that if a future run is ever cut short, the cost lands on a different
  // set of users each time, not systematically on the same two people.
  const order = shuffle(cfgs ?? []);

  const results = await mapWithConcurrency(order, opts.concurrency ?? THINKER_CONCURRENCY, async (c): Promise<ThinkerBatchSummary["results"][number]> => {
    try {
      const r = await runThinker(c.user_id, { prefetch });
      // issue #40: this was the ONLY gap — the manual "Run agent now" button
      // (lib/agent/functions.ts) already fired this same event, but the
      // cron path (responsible for effectively all real agent Claude calls
      // in production, per AGENT-AUDIT.md Part 5) never did, so the admin
      // cost dashboard was silently blind to the majority of real spend.
      void track("agent_run", { userId: c.user_id, properties: { ran: r.ran, aiUsed: r.aiUsed, source: "cron" } });
      const trades = r.executed?.length ?? 0;
      return { userId: c.user_id, ran: r.ran, trades, proposed: r.proposed, reason: r.ran ? undefined : r.reason };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "thinker failed";
      return { userId: c.user_id, ran: false, error: msg };
    }
  });

  const errors = results.filter((r) => r.error).map((r) => `${r.userId}: ${r.error}`);
  const tradesTotal = results.reduce((sum, r) => sum + (r.trades ?? 0), 0);
  const proposalsTotal = results.filter((r) => r.proposed).length;
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
    const summary = await runThinkerForAllAgents();
    // AWAITED (audit finding, 2026-08-16): a fire-and-forget `void` write here
    // was silently lost on most invocations — the serverless function can be
    // frozen/torn down right after `return` fires, before an un-awaited
    // promise's network round-trip to Supabase completes. The heartbeat sat
    // stale for 5 days while the underlying cron ran correctly every single
    // day (confirmed via real `agent_decisions` rows) — a false "stale" signal
    // on /api/health, not a real outage. See AGENT-AUDIT.md Part 1.
    //
    // WRITTEN IMMEDIATELY after the ONE thing this heartbeat names, per this
    // file's 2026-08-19 header — the daily brief used to run here too,
    // between the thinker batch and this write; it's now a fully separate
    // job (lib/insights/cron.server.ts) with its own heartbeat, so nothing
    // unrelated can delay or block this one again.
    await recordHeartbeat("agent-thinker", "ok", { eligible: summary.eligible, processed: summary.processed });
    return json({ ok: true, summary }, 200);
  } catch (e) {
    await recordHeartbeat("agent-thinker", "error", { error: e instanceof Error ? e.message : String(e) });
    return json({ ok: false, error: e instanceof Error ? e.message : "Agent thinker batch failed." }, 500);
  }
}

export async function handleAgentWatchdogRequest(request: Request): Promise<Response> {
  const denied = authorizeCron(request);
  if (denied) return denied;
  try {
    const summary = await runWatchdogForAllAgents();
    // Heartbeat added 2026-08-19 (AGENT-AUDIT.md Part 8 backlog item, folded
    // in while fixing agent-thinker's own heartbeat bug) — the watchdog
    // previously had none at all, the same blindness by construction this
    // whole incident was about. Written even on a market-closed no-op
    // (below) — that IS the watchdog endpoint successfully doing its job for
    // that invocation, not a failure to report on.
    await recordHeartbeat("agent-watchdog", "ok", { eligible: summary.eligible, processed: summary.processed, marketOpen: summary.marketOpen });
    // M1: also run the margin monitor on this INTRADAY cadence (GitHub
    // Actions, every 30m during market hours), not just the once-daily
    // snapshot cron — prices move intraday, so a mid-day drop can push a
    // margin-enabled account into a call hours before the next daily run
    // would otherwise notice it. Reuses the watchdog's OWN market-open
    // result (rather than checking again) so both loops agree on "is the
    // market open right now"; skips cleanly off-hours, same as the watchdog
    // already does, to avoid wasted price fetches on off-hours pings.
    // Isolated in its own try/catch so a margin-monitor failure can't fail
    // the agent watchdog's own response.
    let margin: Awaited<ReturnType<typeof runMarginMonitor>> | { skipped: true } | { error: string };
    if (!summary.marketOpen) {
      margin = { skipped: true };
    } else {
      try {
        margin = await runMarginMonitor();
      } catch (e) {
        margin = { error: e instanceof Error ? e.message : "Margin monitor failed." };
      }
    }
    return json({ ok: true, summary, margin }, 200);
  } catch (e) {
    await recordHeartbeat("agent-watchdog", "error", { error: e instanceof Error ? e.message : String(e) });
    return json({ ok: false, error: e instanceof Error ? e.message : "Agent watchdog batch failed." }, 500);
  }
}
