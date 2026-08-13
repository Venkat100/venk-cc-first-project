// PLAN.md §6 step 10 (B4) — super-admin console server functions.
//
// SECURITY MODEL: every function below verifies the caller's JWT
// (verifyUser) THEN independently re-checks is_admin server-side
// (requireAdmin) before touching any admin data. This is the real
// enforcement boundary — the /app/admin route's client-side redirect and
// the sidebar's conditional nav item are UX only, proven by this file's
// own verify-admin-live.ts calling every one of these functions directly
// with a non-admin token and asserting rejection.
//
// JOURNAL PRIVACY: no function in this file ever selects from
// journal_entries — it has no service_role grant (0023_journal.sql,
// reaffirmed by 0026_admin_console.sql's header) and this file must never
// try to work around that. Grep this file for "journal" — there should be
// no match except this comment.
//
// Deliberately NO impersonation function exists anywhere in this file, and
// none should ever be added — see 0026_admin_console.sql's header and
// HANDOFF for the full reasoning: an impersonated session reads as the
// user, which would defeat the journal privacy boundary above.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import { requireAdmin } from "./requireAdmin.server";
import { isTestAccountEmail } from "./testAccounts";
import { runHealthChecks, type HealthReport } from "@/lib/health/check.server";
import {
  ESTIMATED_COST_PER_INSIGHT_CALL_USD,
  ESTIMATED_COST_PER_AGENT_RUN_USD,
  estimateInsightCostUsd,
  estimateAgentRunCostUsd,
} from "./costEstimates";
import type { AdminAuditLog } from "@/lib/supabase/types";

type Admin = ReturnType<typeof getServiceClient>;

function friendly(token: string): string {
  if (token.includes("not_admin")) return "You don't have access to the admin console.";
  if (token.includes("cannot_suspend_self")) return "You can't suspend your own account.";
  if (token.includes("user_not_found")) return "We couldn't find that user.";
  if (token.includes("not_signed_in")) return "Your session has expired — please sign in again.";
  return "Sorry — that couldn't be completed. Please try again.";
}

/** Fetches every auth user (Admin API, not PostgREST — auth.users isn't
 *  exposed via .from()) and returns an id -> summary map. perPage:1000 is a
 *  documented v1 limitation, not an oversight: at this product's current
 *  scale a single page comfortably covers every user, and paginating
 *  properly is exactly the kind of thing worth building when a real user
 *  count makes it necessary, not preemptively. */
async function listAuthUsersMap(admin: Admin): Promise<Map<string, { email: string; createdAt: string; lastSignInAt: string | null; bannedUntil: string | null }>> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(error.message);
  const map = new Map<string, { email: string; createdAt: string; lastSignInAt: string | null; bannedUntil: string | null }>();
  for (const u of data.users) {
    map.set(u.id, {
      email: u.email ?? "(no email)",
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at ?? null,
      bannedUntil: u.banned_until ?? null,
    });
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
export type AdminUserSummary = {
  id: string;
  email: string;
  signupAt: string;
  lastSignInAt: string | null;
  isAdmin: boolean;
  suspendedAt: string | null;
  cashBalance: number;
  startingCapital: number;
};

export type ListUsersResponse = { ok: true; users: AdminUserSummary[] } | { ok: false; error: string };

export const listUsersFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), query: z.string().optional() }))
  .handler(async ({ data }): Promise<ListUsersResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      const admin = getServiceClient();

      const [authMap, profilesRes] = await Promise.all([
        listAuthUsersMap(admin),
        admin.from("profiles").select("id, is_admin, suspended_at, cash_balance, starting_capital, created_at"),
      ]);
      if (profilesRes.error) return { ok: false, error: friendly(profilesRes.error.message) };

      const q = data.query?.trim().toLowerCase();
      const users: AdminUserSummary[] = (profilesRes.data ?? [])
        .map((p) => {
          const auth = authMap.get(p.id);
          return {
            id: p.id,
            email: auth?.email ?? "(unknown)",
            signupAt: p.created_at,
            lastSignInAt: auth?.lastSignInAt ?? null,
            isAdmin: p.is_admin,
            suspendedAt: p.suspended_at,
            cashBalance: Number(p.cash_balance),
            startingCapital: Number(p.starting_capital),
          };
        })
        .filter((u) => !q || u.email.toLowerCase().includes(q))
        .sort((a, b) => new Date(b.signupAt).getTime() - new Date(a.signupAt).getTime());

      return { ok: true, users };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type AdminUserDetail = {
  id: string;
  email: string;
  signupAt: string;
  lastSignInAt: string | null;
  isAdmin: boolean;
  suspendedAt: string | null;
  cashBalance: number;
  startingCapital: number;
  marginEnabled: boolean;
  marginLoan: number;
  marginStatus: string;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  optionsUnlockedAt: string | null;
  marginUnlockedAt: string | null;
  holdingsCount: number;
  // Cost-basis (qty × avg_cost), NOT live market value — showing this
  // requires zero extra market-data provider calls, deliberately, since
  // this console itself cares about keeping provider call volume visible
  // and low (see getUsageStatsFn). Labeled as cost basis in the UI.
  holdingsCostBasisValue: number;
  transactionCount: number;
  optionPositionsCount: number;
  optionTransactionCount: number;
  agentEnabled: boolean;
  agentCash: number | null;
  agentHoldingsCount: number;
  scenarioRunsActive: number;
  scenarioRunsCompleted: number;
};

export type GetUserDetailResponse = { ok: true; user: AdminUserDetail } | { ok: false; error: string };

export const getUserDetailFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), targetUserId: z.string().min(1) }))
  .handler(async ({ data }): Promise<GetUserDetailResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      const admin = getServiceClient();
      const targetUserId = data.targetUserId;

      const [authRes, profileRes, holdingsRes, txRes, optPosRes, optTxRes, agentRes, agentHoldingsRes, scenarioRes] = await Promise.all([
        admin.auth.admin.getUserById(targetUserId),
        admin.from("profiles").select("*").eq("id", targetUserId).maybeSingle(),
        admin.from("holdings").select("quantity, avg_cost").eq("user_id", targetUserId),
        admin.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", targetUserId),
        admin.from("option_positions").select("id", { count: "exact", head: true }).eq("user_id", targetUserId),
        admin.from("option_transactions").select("id", { count: "exact", head: true }).eq("user_id", targetUserId),
        admin.from("agent_config").select("enabled, agent_cash").eq("user_id", targetUserId).maybeSingle(),
        admin.from("agent_holdings").select("id", { count: "exact", head: true }).eq("user_id", targetUserId),
        admin.from("scenario_runs").select("status").eq("user_id", targetUserId),
      ]);

      if (!profileRes.data) return { ok: false, error: friendly("user_not_found") };
      const p = profileRes.data;
      const email = authRes.data.user?.email ?? "(unknown)";

      const holdingsCostBasisValue = (holdingsRes.data ?? []).reduce((sum, h) => sum + Number(h.quantity) * Number(h.avg_cost), 0);
      const scenarioRows = scenarioRes.data ?? [];

      // AWAITED, not fire-and-forget: a fire-and-forget `void admin.rpc(...)`
      // here was empirically confirmed (2026-08-12 browser verification) to
      // silently drop the write — the request handler's async context
      // doesn't reliably keep an unawaited promise alive past the response.
      // "Every admin action recorded immutably" is a hard requirement (the
      // kickoff's own words), so the extra ~150ms round-trip is the correct
      // tradeoff over a demonstrated audit gap. If this write itself fails,
      // surface it rather than silently returning an unaudited view.
      const logRes = await admin.rpc("admin_log_action", {
        p_admin_id: userId,
        p_action: "view_user",
        p_target_user_id: targetUserId,
        p_detail: null,
      });
      if (logRes.error) return { ok: false, error: friendly(logRes.error.message) };

      return {
        ok: true,
        user: {
          id: p.id,
          email,
          signupAt: p.created_at,
          lastSignInAt: authRes.data.user?.last_sign_in_at ?? null,
          isAdmin: p.is_admin,
          suspendedAt: p.suspended_at,
          cashBalance: Number(p.cash_balance),
          startingCapital: Number(p.starting_capital),
          marginEnabled: p.margin_enabled,
          marginLoan: Number(p.margin_loan),
          marginStatus: p.margin_status,
          termsAcceptedAt: p.terms_accepted_at,
          termsVersion: p.terms_version,
          optionsUnlockedAt: p.options_unlocked_at,
          marginUnlockedAt: p.margin_unlocked_at,
          holdingsCount: (holdingsRes.data ?? []).length,
          holdingsCostBasisValue,
          transactionCount: txRes.count ?? 0,
          optionPositionsCount: optPosRes.count ?? 0,
          optionTransactionCount: optTxRes.count ?? 0,
          agentEnabled: agentRes.data?.enabled ?? false,
          agentCash: agentRes.data ? Number(agentRes.data.agent_cash) : null,
          agentHoldingsCount: agentHoldingsRes.count ?? 0,
          scenarioRunsActive: scenarioRows.filter((r) => r.status === "active").length,
          scenarioRunsCompleted: scenarioRows.filter((r) => r.status === "completed").length,
        },
      };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type SetUserSuspendedResponse = { ok: true; suspended: boolean; suspendedAt: string | null } | { ok: false; error: string };

export const setUserSuspendedFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), targetUserId: z.string().min(1), suspended: z.boolean() }))
  .handler(async ({ data }): Promise<SetUserSuspendedResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      const admin = getServiceClient();

      // The RPC does the state change AND the audit write atomically — see
      // 0026_admin_console.sql's admin_set_suspended. This call is the
      // source of truth; it also independently re-verifies is_admin and
      // rejects a self-suspend attempt server-side.
      const rpc = await admin.rpc("admin_set_suspended", {
        p_admin_id: userId,
        p_target_user_id: data.targetUserId,
        p_suspended: data.suspended,
      });
      if (rpc.error) return { ok: false, error: friendly(rpc.error.message) };

      // GoTrue-level ban — the actual login-blocking mechanism. Runs AFTER
      // the atomic flag+audit write on purpose: if this fails, the failure
      // is visible (flag says suspended, ban call errored) rather than the
      // reverse (user actually banned, our own audit trail silently
      // missing the reason) — see the migration header for the full
      // ordering rationale.
      const ban = await admin.auth.admin.updateUserById(data.targetUserId, {
        ban_duration: data.suspended ? "876000h" : "none",
      });
      if (ban.error) {
        return {
          ok: false,
          error: `Recorded the suspension, but the login-blocking step failed (${ban.error.message}) — try again.`,
        };
      }

      const row = rpc.data as { suspended_at: string | null };
      return { ok: true, suspended: data.suspended, suspendedAt: row.suspended_at };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type DeleteUserResponse = { ok: true } | { ok: false; error: string };

export const deleteUserFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), targetUserId: z.string().min(1) }))
  .handler(async ({ data }): Promise<DeleteUserResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      if (data.targetUserId === userId) {
        return { ok: false, error: "You can't delete your own account from the admin console — use Settings instead." };
      }
      const admin = getServiceClient();

      const before = await admin.auth.admin.getUserById(data.targetUserId);
      const targetEmail = before.data.user?.email ?? "unknown";

      // Logged BEFORE the delete, with target_user_id still valid (the row
      // exists), so the FK + the SQL function's own auth.users lookup can
      // both succeed. Every step below is best-effort logged too, so a
      // failed delete is a visible, honest audit entry, not a silent gap.
      const preLog = await admin.rpc("admin_log_action", {
        p_admin_id: userId,
        p_action: "delete_user",
        p_target_user_id: data.targetUserId,
        p_detail: { status: "attempting", email: targetEmail },
      });
      if (preLog.error) return { ok: false, error: friendly(preLog.error.message) };

      const del = await admin.auth.admin.deleteUser(data.targetUserId);
      if (del.error) {
        // target_user_id must be omitted here — the row is (or may be)
        // already gone, and admin_audit_log's FK requires the referenced
        // auth.users row to exist at INSERT time (ON DELETE SET NULL only
        // protects EXISTING rows when a later delete happens, not a fresh
        // insert referencing an already-deleted id).
        await admin.rpc("admin_log_action", {
          p_admin_id: userId,
          p_action: "delete_user_failed",
          p_target_user_id: null,
          p_detail: { email: targetEmail, error: del.error.message },
        });
        return { ok: false, error: "Sorry — we couldn't delete that account. Please try again." };
      }

      await admin.rpc("admin_log_action", {
        p_admin_id: userId,
        p_action: "delete_user_completed",
        p_target_user_id: null,
        p_detail: { email: targetEmail },
      });

      return { ok: true };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type UsageStats = {
  windowDays: number;
  insightCalls: { total: number; byKind: { stock: number; brief: number }; estimatedCostUsd: number };
  agentRuns: { total: number; estimatedCostUsd: number; note: string };
  providerFetches: { total: number; note: string };
  rateLimitRejections: { total: number; byAction: Record<string, number>; byReason: { burst: number; daily: number } };
  perUserCost: { userId: string; email: string; isTestAccount: boolean; insightCalls: number; agentRuns: number; estimatedCostUsd: number }[];
  assumedRates: { insightCallUsd: number; agentRunUsd: number };
  // Real vs. throwaway-test account split (2026-08-13 app audit, Part 5/6)
  // — computed from the SAME auth-user listing already fetched for
  // perUserCost's email lookup, zero extra query. Answers exactly the
  // question the audit found impossible to answer from analytics_events
  // alone: how many of these accounts are real. note explains the method
  // so this number is never mistaken for a database-enforced fact.
  accountCounts: { real: number; test: number; note: string };
};

export type GetUsageStatsResponse = { ok: true; stats: UsageStats } | { ok: false; error: string };

export const getUsageStatsFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), days: z.number().int().positive().max(365).optional() }))
  .handler(async ({ data }): Promise<GetUsageStatsResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      const admin = getServiceClient();
      const windowDays = data.days ?? 30;
      const windowStartTimestamp = new Date(Date.now() - windowDays * 86_400_000).toISOString();
      const windowStartDate = windowStartTimestamp.slice(0, 10); // insights.created_at is a `date`, not timestamptz

      const [insightsRes, eventsRes, fetchesRes, authMap] = await Promise.all([
        admin.from("insights").select("kind, user_id, created_at").gte("created_at", windowStartDate),
        admin
          .from("analytics_events")
          .select("event, user_id, properties, created_at")
          .in("event", ["agent_run", "rate_limited"])
          .gte("created_at", windowStartTimestamp),
        admin.from("price_cache").select("kind", { count: "exact", head: true }).gte("fetched_at", windowStartTimestamp),
        listAuthUsersMap(admin),
      ]);
      if (insightsRes.error) return { ok: false, error: friendly(insightsRes.error.message) };
      if (eventsRes.error) return { ok: false, error: friendly(eventsRes.error.message) };
      if (fetchesRes.error) return { ok: false, error: friendly(fetchesRes.error.message) };

      const insightRows = insightsRes.data ?? [];
      const stockCalls = insightRows.filter((r) => r.kind === "stock").length;
      const briefCalls = insightRows.filter((r) => r.kind === "brief").length;
      const totalInsightCalls = insightRows.length;

      const eventRows = eventsRes.data ?? [];
      const agentRunRows = eventRows.filter((r) => r.event === "agent_run");
      const rateLimitedRows = eventRows.filter((r) => r.event === "rate_limited");

      const byAction: Record<string, number> = {};
      let burstCount = 0;
      let dailyCount = 0;
      for (const r of rateLimitedRows) {
        const props = (r.properties ?? {}) as { action?: string; reason?: string };
        if (props.action) byAction[props.action] = (byAction[props.action] ?? 0) + 1;
        if (props.reason === "burst") burstCount++;
        else if (props.reason === "daily") dailyCount++;
      }

      // Per-user attribution: only kind='brief' insights carry a user_id
      // (kind='stock' is shared/global, user_id is NULL by design —
      // 0009_insights.sql) plus agent_run events.
      const perUserMap = new Map<string, { insightCalls: number; agentRuns: number }>();
      for (const r of insightRows) {
        if (r.kind !== "brief" || !r.user_id) continue;
        const entry = perUserMap.get(r.user_id) ?? { insightCalls: 0, agentRuns: 0 };
        entry.insightCalls++;
        perUserMap.set(r.user_id, entry);
      }
      for (const r of agentRunRows) {
        if (!r.user_id) continue;
        const entry = perUserMap.get(r.user_id) ?? { insightCalls: 0, agentRuns: 0 };
        entry.agentRuns++;
        perUserMap.set(r.user_id, entry);
      }
      const perUserCost = [...perUserMap.entries()]
        .map(([uid, v]) => {
          const email = authMap.get(uid)?.email ?? "(unknown)";
          return {
            userId: uid,
            email,
            isTestAccount: isTestAccountEmail(email),
            insightCalls: v.insightCalls,
            agentRuns: v.agentRuns,
            estimatedCostUsd: estimateInsightCostUsd(v.insightCalls) + estimateAgentRunCostUsd(v.agentRuns),
          };
        })
        .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
        .slice(0, 20);

      let realAccountCount = 0;
      let testAccountCount = 0;
      for (const u of authMap.values()) {
        if (isTestAccountEmail(u.email)) testAccountCount++;
        else realAccountCount++;
      }

      const stats: UsageStats = {
        windowDays,
        insightCalls: {
          total: totalInsightCalls,
          byKind: { stock: stockCalls, brief: briefCalls },
          estimatedCostUsd: estimateInsightCostUsd(totalInsightCalls),
        },
        agentRuns: {
          total: agentRunRows.length,
          estimatedCostUsd: estimateAgentRunCostUsd(agentRunRows.length),
          note: "Upper bound — counts every 'Run agent now' click, including quant-only runs that make zero Claude calls (per-run AI-used isn't tracked).",
        },
        providerFetches: {
          total: fetchesRes.count ?? 0,
          note: "Real, exact count of price_cache upserts (i.e. genuine provider cache MISSES) in this window — not an estimate. True hit/miss counting isn't instrumented (it would require a write on every cache read, on the hottest code path in the app), so no fabricated hit-rate % is shown.",
        },
        rateLimitRejections: {
          total: rateLimitedRows.length,
          byAction,
          byReason: { burst: burstCount, daily: dailyCount },
        },
        perUserCost,
        assumedRates: {
          insightCallUsd: ESTIMATED_COST_PER_INSIGHT_CALL_USD,
          agentRunUsd: ESTIMATED_COST_PER_AGENT_RUN_USD,
        },
        accountCounts: {
          real: realAccountCount,
          test: testAccountCount,
          note: "Test = email ends in @example.org/.com/.net — the RFC 2606 reserved-for-documentation domains every verify-*.ts script's throwaway accounts use (no real signup can ever use them). Not a stored flag; computed at read time from the current account list.",
        },
      };

      return { ok: true, stats };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type GetSystemHealthResponse = { ok: true; report: HealthReport } | { ok: false; error: string };

export const getSystemHealthFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1) }))
  .handler(async ({ data }): Promise<GetSystemHealthResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      const report = await runHealthChecks();
      return { ok: true, report };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });

// ─────────────────────────────────────────────────────────────────────────
export type GetAuditLogResponse = { ok: true; entries: AdminAuditLog[] } | { ok: false; error: string };

export const getAuditLogFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1), limit: z.number().int().positive().max(500).optional(), offset: z.number().int().min(0).optional() }))
  .handler(async ({ data }): Promise<GetAuditLogResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      await requireAdmin(userId);
      const admin = getServiceClient();
      const limit = data.limit ?? 100;
      const offset = data.offset ?? 0;
      const { data: rows, error } = await admin
        .from("admin_audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) return { ok: false, error: friendly(error.message) };
      return { ok: true, entries: (rows ?? []) as AdminAuditLog[] };
    } catch (e) {
      return { ok: false, error: friendly(e instanceof Error ? e.message : "error") };
    }
  });
