// AI Agent — TanStack Start server functions (Phase 10.1).
//
// Security: identity comes from a VERIFIED Supabase JWT (verifyUser), never a
// client-sent user_id. All writes use the service-role client. Funding moves
// virtual cash atomically via the fund_agent() DB function (service_role only).
// No market-data or LLM calls in this phase.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServiceClient, verifyUser } from "@/lib/supabase/admin.server";
import type { AgentConfig } from "@/lib/supabase/types";

type Admin = ReturnType<typeof getServiceClient>;

async function readConfig(admin: Admin, userId: string): Promise<AgentConfig> {
  // Create the row on first access, then read it back.
  await admin.from("agent_config").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data, error } = await admin.from("agent_config").select("*").eq("user_id", userId).single();
  if (error) throw new Error(error.message);
  return data as AgentConfig;
}

export const getAgentConfigFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accessToken: z.string().min(1) }))
  .handler(async ({ data }): Promise<AgentConfig> => {
    const userId = await verifyUser(data.accessToken);
    return readConfig(getServiceClient(), userId);
  });

export const updateAgentConfigFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      enabled: z.boolean().optional(),
      mode: z.enum(["autonomous", "approve"]).optional(),
      risk_level: z.enum(["conservative", "balanced", "aggressive"]).optional(),
    }),
  )
  .handler(async ({ data }): Promise<AgentConfig> => {
    const userId = await verifyUser(data.accessToken);
    const admin = getServiceClient();
    await admin.from("agent_config").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.mode !== undefined) patch.mode = data.mode;
    if (data.risk_level !== undefined) patch.risk_level = data.risk_level;

    const { error } = await admin.from("agent_config").update(patch).eq("user_id", userId);
    if (error) throw new Error(error.message);
    return readConfig(admin, userId);
  });

export type FundResponse =
  | { ok: true; cashBalance: number; agentCash: number; allocatedTotal: number }
  | { ok: false; error: string };

function fundFriendly(token: string): string {
  if (token.includes("insufficient_cash")) return "Not enough virtual cash to fund that amount.";
  if (token.includes("insufficient_agent_cash")) return "The agent doesn't have that much uninvested cash to withdraw.";
  if (token.includes("invalid_amount")) return "Enter a non-zero amount.";
  if (token.includes("not_signed_in")) return "Your session has expired — please sign in again.";
  if (token.includes("profile_not_found")) return "We couldn't find your account.";
  return "That transfer couldn't be completed. Please try again.";
}

export const fundAgentFn = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(1),
      // positive = fund (main → agent); negative = withdraw (agent → main)
      amount: z.number().finite(),
    }),
  )
  .handler(async ({ data }): Promise<FundResponse> => {
    try {
      const userId = await verifyUser(data.accessToken);
      const admin = getServiceClient();
      const { data: rpc, error } = await admin.rpc("fund_agent", { p_user_id: userId, p_amount: data.amount });
      if (error) return { ok: false, error: fundFriendly(error.message) };
      const r = rpc as Record<string, unknown>;
      return {
        ok: true,
        cashBalance: Number(r.cash_balance),
        agentCash: Number(r.agent_cash),
        allocatedTotal: Number(r.allocated_total),
      };
    } catch (e) {
      return { ok: false, error: fundFriendly(e instanceof Error ? e.message : "error") };
    }
  });
