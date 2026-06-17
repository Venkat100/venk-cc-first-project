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
