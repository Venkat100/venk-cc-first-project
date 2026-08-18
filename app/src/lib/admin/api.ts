// Client entry points for the super-admin console. Same token-attached
// pattern as lib/scenarios/api.ts / lib/margin/api.ts.

import { supabase } from "@/lib/supabase/client";
import {
  listUsersFn,
  getUserDetailFn,
  setUserSuspendedFn,
  deleteUserFn,
  getUsageStatsFn,
  getSystemHealthFn,
  getAuditLogFn,
  getIdleAgentsFn,
  listTestAccountsFn,
  deleteTestAccountsFn,
  testSentryDeliveryFn,
  type AdminUserSummary,
  type AdminUserDetail,
  type UsageStats,
  type IdleAgent,
  type TestAccountSummary,
} from "./functions";
import type { HealthReport } from "@/lib/health/check.server";
import type { AdminAuditLog } from "@/lib/supabase/types";

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Your session has expired — please sign in again.");
  return t;
}

export async function listUsers(query?: string): Promise<AdminUserSummary[]> {
  const res = await listUsersFn({ data: { accessToken: await token(), query } });
  if (!res.ok) throw new Error(res.error);
  return res.users;
}

export async function getUserDetail(targetUserId: string): Promise<AdminUserDetail> {
  const res = await getUserDetailFn({ data: { accessToken: await token(), targetUserId } });
  if (!res.ok) throw new Error(res.error);
  return res.user;
}

export async function setUserSuspended(targetUserId: string, suspended: boolean): Promise<{ suspended: boolean; suspendedAt: string | null }> {
  const res = await setUserSuspendedFn({ data: { accessToken: await token(), targetUserId, suspended } });
  if (!res.ok) throw new Error(res.error);
  return { suspended: res.suspended, suspendedAt: res.suspendedAt };
}

export async function deleteUser(targetUserId: string): Promise<void> {
  const res = await deleteUserFn({ data: { accessToken: await token(), targetUserId } });
  if (!res.ok) throw new Error(res.error);
}

export async function getUsageStats(days?: number): Promise<UsageStats> {
  const res = await getUsageStatsFn({ data: { accessToken: await token(), days } });
  if (!res.ok) throw new Error(res.error);
  return res.stats;
}

export async function getSystemHealth(): Promise<HealthReport> {
  const res = await getSystemHealthFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return res.report;
}

export async function getAuditLog(limit?: number, offset?: number): Promise<AdminAuditLog[]> {
  const res = await getAuditLogFn({ data: { accessToken: await token(), limit, offset } });
  if (!res.ok) throw new Error(res.error);
  return res.entries;
}

/** Funded, enabled agents idle beyond the never-traded (3d) / went-quiet
 *  (14d) thresholds — AGENT-AUDIT.md Part 8 §4B. */
export async function getIdleAgents(): Promise<{ agents: IdleAgent[]; checkedAt: string }> {
  const res = await getIdleAgentsFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return { agents: res.agents, checkedAt: res.checkedAt };
}

/** Every account matching the reserved test-account email pattern
 *  (isTestAccountEmail) — AGENT-AUDIT.md's leftover-throwaway-accounts
 *  finding, made a normal admin-console list instead of a script. */
export async function listTestAccounts(): Promise<TestAccountSummary[]> {
  const res = await listTestAccountsFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return res.accounts;
}

/** Deletes the given test accounts. The server independently re-verifies
 *  every id still matches the test-email pattern before deleting anything —
 *  this can never remove an account that check wouldn't also flag. */
export async function deleteTestAccounts(userIds: string[]): Promise<{ deleted: string[]; failed: { email: string; error: string }[] }> {
  const res = await deleteTestAccountsFn({ data: { accessToken: await token(), userIds } });
  if (!res.ok) throw new Error(res.error);
  return { deleted: res.deleted, failed: res.failed };
}

/** Fires one real, marked Sentry test event through the SAME
 *  captureServerError() every production error goes through — admin
 *  console re-verification of the 2026-08-17 finding, not a one-time
 *  proof (2026-08-17 incident writeup, HANDOFF.md). */
export async function testSentryDelivery(): Promise<{ sentryConfigured: boolean; eventId?: string; marker?: string }> {
  const res = await testSentryDeliveryFn({ data: { accessToken: await token() } });
  if (!res.ok) throw new Error(res.error);
  return { sentryConfigured: res.sentryConfigured, eventId: res.eventId, marker: res.marker };
}

export type { AdminUserSummary, AdminUserDetail, UsageStats, IdleAgent, TestAccountSummary } from "./functions";
export type { HealthReport } from "@/lib/health/check.server";
export type { AdminAuditLog } from "@/lib/supabase/types";
