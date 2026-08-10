// Client-side Sentry wiring (PLAN.md §6 step 5, part A3). No-op-safe when
// VITE_SENTRY_DSN isn't set (local dev, or before Venky supplies the real
// project DSN) — init() and captureClientError() both just return
// immediately rather than throwing or logging noise.
//
// VITE_SENTRY_DSN is intentionally PUBLIC (VITE_-prefixed, ships to the
// browser) — a Sentry DSN is designed to be public: it's a write-only
// ingest address, it can only submit new events, never read, modify, or
// delete anything, and Sentry's own docs treat it the same way a public
// API endpoint is treated. This is categorically different from every
// other server-only secret in this codebase (Finnhub/Twelve Data/Supabase
// service-role/Anthropic keys), all of which stay out of VITE_ vars.
//
// tracesSampleRate is 0 deliberately: the ask here is ERROR monitoring,
// not performance tracing — tracing is a separate Sentry feature with its
// own overhead/data-volume cost that nothing in this step asked for.

import * as Sentry from "@sentry/react";

let initialized = false;

export function initClientSentry(): void {
  if (initialized || typeof window === "undefined") return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({ dsn, tracesSampleRate: 0, environment: import.meta.env.MODE });
  initialized = true;
}

/** Never include secrets/tokens/full auth payloads in `context` — only
 *  debug-shaped values (route, action, non-sensitive ids). */
export function captureClientError(error: unknown, context: Record<string, unknown> = {}): void {
  if (!initialized) return;
  Sentry.captureException(error, { extra: context });
}
