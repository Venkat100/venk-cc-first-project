// PLAN.md §6 step 10 (B4) — super-admin console. The SERVER-SIDE admin
// gate. Every admin server function calls this immediately after
// verifyUser(accessToken) and before touching any admin data — this is the
// actual security boundary, not the /app/admin route's client-side redirect
// or the sidebar's conditional nav item, both of which are UX only and
// trivially bypassable by calling a server function directly.
//
// Deliberately re-checks the DB on every call rather than trusting a claim
// embedded in the JWT: is_admin has no client write path at all (see
// 0026_admin_console.sql's header), so a fresh SELECT is cheap and gives
// the current, real value — no caching, no staleness window in which a
// just-revoked admin could still act.

import { getServiceClient } from "@/lib/supabase/admin.server";

export class NotAdminError extends Error {
  constructor() {
    super("not_admin");
    this.name = "NotAdminError";
  }
}

/** Throws NotAdminError if `userId` is not an admin. Every admin-only
 *  server function must call this before doing any privileged work. */
export async function requireAdmin(userId: string): Promise<void> {
  const admin = getServiceClient();
  const { data, error } = await admin.from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  if (error) throw new Error(`admin check failed: ${error.message}`);
  if (!data || data.is_admin !== true) throw new NotAdminError();
}
