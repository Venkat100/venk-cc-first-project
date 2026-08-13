import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// ─────────────────────────────────────────────────────────────
// The ONE Supabase client for the whole frontend.
//
// Rule (CLAUDE.md): nothing else in the app may call createClient().
// Always import { supabase } from "@/lib/supabase/client".
//
// Both values are PUBLIC (VITE_ prefix → shipped to the browser). The
// publishable/anon key is safe to expose; Row-Level Security is what
// actually protects data. Never put a secret key here.
// ─────────────────────────────────────────────────────────────

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loudly in dev so a missing .env is obvious rather than a vague
  // runtime error deep in an auth call.
  throw new Error(
    "Missing Supabase env vars. Copy app/.env.example to app/.env and set " +
      "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
  );
}

// Same audit that found admin.server.ts's getServiceClient() had no fetch
// timeout (2026-08-12, a real multi-hour server-side hang) applies here
// too: without this, a stalled connection leaves a signed-in user's tab
// spinning on an auth/query call indefinitely, with nothing converting it
// into a retryable error. 30s (vs. 20s server-side) since this client also
// carries genuinely larger payloads over the user's own, more variable,
// network conditions.
const BROWSER_FETCH_TIMEOUT_MS = 30_000;

async function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSER_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Request timed out after ${BROWSER_FETCH_TIMEOUT_MS}ms — please check your connection and try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Persist the session in localStorage and refresh tokens automatically so
    // the user stays logged in across reloads.
    persistSession: true,
    autoRefreshToken: true,
    // Handle the `#access_token=...` fragment on redirect back from email
    // confirmation / magic links.
    detectSessionInUrl: true,
    flowType: "pkce",
  },
  global: { fetch: timedFetch },
});
