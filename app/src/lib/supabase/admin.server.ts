// Server-only Supabase access for privileged operations (trade execution).
//
// `.server.ts` ⇒ never bundled to the browser. The service_role key bypasses
// Row-Level Security, so it must stay here and never leak to the client.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireServerEnv } from "@/lib/marketData/env.server";

// The project URL is public (also used by the browser client), safe to inline.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

// ROOT CAUSE of two separate multi-hour silent hangs (2026-08-11 scenario
// verification, 2026-08-12 admin console verification): this client had NO
// timeout on ANY call — auth admin API, postgrest, rpc, all of it — so a
// stalled connection waited forever with nothing to convert it into a
// rejection. The first incident fixed the equivalent bug in
// provider.server.ts's raw fetch() calls but explicitly left this client
// untouched ("a residual risk, deliberately not touched to avoid
// regressions across every feature using getServiceClient()") — that
// deferral is exactly what caused the second incident, and this ALSO
// affects PRODUCTION, not just verify scripts: every server function in
// this app goes through getServiceClient(), so an unresponsive-but-open
// connection to Supabase could hang a real request indefinitely until
// Vercel's own function timeout kills it, with none of our own code ever
// getting a chance to return a clean error.
//
// Supabase's own JS client accepts a custom fetch via `global.fetch`
// (SupabaseClientOptions) — supabase-js routes EVERY call (auth.*, .from(),
// .rpc()) through this one function, so wrapping it here is a single,
// unavoidable choke point rather than something each call site could
// forget, matching the "push the timeout down into the shared primitive"
// principle rather than relying on every caller to remember a wrapper.
const SERVICE_CLIENT_FETCH_TIMEOUT_MS = 20_000;

async function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVICE_CLIENT_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Supabase service-role request timed out after ${SERVICE_CLIENT_FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** A Supabase client authenticated with the service_role key (bypasses RLS). */
export function getServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, requireServerEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: timedFetch },
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
