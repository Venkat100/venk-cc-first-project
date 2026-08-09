// Client-side entry point for permanently deleting the account. Attaches
// the user's current access token; unwraps the server function's
// { ok, error } envelope into a value-or-throw.

import { supabase } from "@/lib/supabase/client";
import { deleteAccountFn } from "./functions";

export async function deleteAccount(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session has expired — please sign in again.");

  const res = await deleteAccountFn({ data: { accessToken: token } });
  if (!res.ok) throw new Error(res.error);
}
