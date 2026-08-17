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
  type AdminUserSummary,
  type AdminUserDetail,
  type UsageStats,
  type IdleAgent,
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

export type { AdminUserSummary, AdminUserDetail, UsageStats, IdleAgent } from "./functions";
export type { HealthReport } from "@/lib/health/check.server";
export type { AdminAuditLog } from "@/lib/supabase/types";
