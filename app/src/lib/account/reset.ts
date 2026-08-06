// Client-side entry point for resetting the paper account (C1b). Attaches
// the user's current access token; unwraps the server function's
// { ok, error } envelope into a value-or-throw.

import { supabase } from "@/lib/supabase/client";
import { resetPaperAccountFn, type ResetPaperAccountResult } from "./functions";

export async function resetPaperAccount(): Promise<ResetPaperAccountResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired — please sign in again.");

  const res = await resetPaperAccountFn({ data: { accessToken: token } });
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export type { ResetPaperAccountResult } from "./functions";
