// Server-side Sentry wiring (PLAN.md §6 step 5, part A3) — server-only, no-op-safe
// when SENTRY_DSN isn't set. Wired at TWO seams rather than into each of the
// ~20 individual server functions' own try/catch blocks:
//   1. start.ts's requestMiddleware — catches anything that escapes a server
//      function's OWN handler (genuinely unexpected bugs/crashes), with
//      route + which server function was being called.
//   2. server.ts's top-level fetch catch-all — catches anything that
//      escapes even the framework layer (SSR render crashes, routing
//      failures).
// Deliberately NOT added inside each server function's individual
// try/catch: those mostly catch EXPECTED, already-friendly user-facing
// rejections ("insufficient buying power", "not enough shares") — routing
// every one of those into Sentry would just be noise, not signal. The two
// seams above catch real bugs regardless of which server function they
// originate in, without touching ~20 files individually.

import * as Sentry from "@sentry/node";
import { serverEnv } from "@/lib/marketData/env.server";

let initialized = false;
let dsnChecked = false;

function ensureInit(): void {
  if (dsnChecked) return;
  dsnChecked = true;
  const dsn = serverEnv("SENTRY_DSN");
  if (!dsn) return;
  Sentry.init({ dsn, tracesSampleRate: 0, environment: serverEnv("NODE_ENV") ?? "production" });
  initialized = true;
}

/** Never include secrets/tokens/full auth payloads in `context` — only
 *  debug-shaped values (userId, route, action). Returns the Sentry event
 *  id (for tests/verification to look the event up by), or undefined when
 *  Sentry isn't configured (no-op case). */
export function captureServerError(error: unknown, context: Record<string, unknown> = {}): string | undefined {
  ensureInit();
  if (!initialized) return undefined;
  let eventId: string | undefined;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    eventId = Sentry.captureException(error);
  });
  return eventId;
}
