// Server-only Supabase access for privileged operations (trade execution).
//
// `.server.ts` ⇒ never bundled to the browser. The service_role key bypasses
// Row-Level Security, so it must stay here and never leak to the client.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireServerEnv } from "@/lib/marketData/env.server";

// The project URL is public (also used by the browser client), safe to inline.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

/** A Supabase client authenticated with the service_role key (bypasses RLS). */
export function getServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, requireServerEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Verify a Supabase access token (JWT) and return the authenticated user id.
 * The token is validated by Supabase's auth server — we never trust a
 * client-supplied user_id. Throws "not_signed_in" if invalid/expired.
 */
export async function verifyUser(accessToken: string): Promise<string> {
  const supa = getServiceClient();
  const { data, error } = await supa.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("not_signed_in");
  return data.user.id;
}

// ── Supabase write-result checking ──────────────────────────────────────────
// Found during M1 verification: a Postgres/PostgREST error on `.insert()` /
// `.update()` / `.upsert()` / `.delete()` / `.rpc()` never throws on its own
// — it comes back as `{ error }` on the result, so a call whose result is
// awaited-and-discarded silently drops the failure (this is exactly how a
// real, previously-shipped bug in the margin monitor went undetected — see
// 0014's migration header). These two helpers make that impossible to do by
// accident going forward: pass the awaited result through one of them
// instead of letting it fall on the floor.

type SupabaseResult = { error: { message: string } | null };

/** Correctness-critical write: a silent failure here could leave state
 *  inconsistent in a way a later step trusts (e.g. a status flag that gates
 *  "has this already been done"). Throws with `label` + the underlying
 *  Postgres message so the caller's own error handling takes over. */
export function mustSucceed(label: string, result: SupabaseResult): void {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

/** Best-effort write inside a per-item batch (one row's failure must not
 *  abort the rest of the batch — matches this codebase's existing cron/
 *  batch-job convention of collecting failures into an `errors` array
 *  instead of throwing). Pushes a labeled message into the caller's array
 *  rather than swallowing the error. */
export function logIfFailed(label: string, result: SupabaseResult, errors: string[]): void {
  if (result.error) errors.push(`${label}: ${result.error.message}`);
}
