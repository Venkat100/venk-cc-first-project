// Config-fingerprinting (2026-08-18, closing the day's second incident
// structurally — see HANDOFF.md). A presence check alone only catches a
// variable being ABSENT (2026-08-17's Sentry incident); it says nothing
// when a variable is PRESENT but holds the WRONG value (2026-08-17's
// ANTHROPIC_API_KEY incident — an intentional rotation silently didn't
// apply, and production kept running on the old key with no error). A
// short one-way hash of the value, compared against the same hash computed
// from the value that's SUPPOSED to be configured, catches both.
//
// SECURITY — read before adding a variable to FINGERPRINTED_ENV_VARS below:
// a truncated hash is only safe to expose for a HIGH-ENTROPY value (a
// long, randomly-generated secret — an API key, a service-role key, a
// shared secret). For a LOW-ENTROPY value (anything from a small, guessable
// set — e.g. AGENT_MODEL, which is one of a handful of real Anthropic
// model names) a hash is NOT meaningfully protective: an attacker can hash
// every candidate value themselves and compare against what this endpoint
// exposes, confirming the true value with no brute-force cost at all.
// AGENT_MODEL is deliberately reported as a plain string (config.agentModel
// in check.server.ts), not fingerprinted here, for exactly this reason —
// it isn't secret, so there's nothing to protect, but it also isn't
// HIGH-entropy, so fingerprinting it would create a false impression of
// protection where none exists.
//
// This module's fingerprints are unsalted SHA-256, truncated to 8 hex
// chars. Salting was considered and deliberately rejected: salting
// defends against a PRECOMPUTED rainbow table over a small candidate
// space — exactly the AGENT_MODEL risk above — which doesn't apply here,
// since every fingerprinted value below is a long, randomly-generated
// secret already computationally infeasible to brute-force, salted or
// not. Salting would add a real cost with no matching benefit: the salt
// itself would need to be a shared, server-only value present in BOTH
// app/.env (for check-config-fingerprint.ts's local comparison) and
// Vercel (for check.server.ts's production computation) — a NEW value
// that could itself drift between the two, producing a false-positive
// mismatch that has nothing to do with the secret actually changing. That
// failure mode is exactly the class of bug this whole mechanism exists to
// eliminate, so introducing a new place for it to happen is a net loss.
//
// EXPOSURE DEPENDENCY — this is the actual reason these fingerprints are
// safe to return at all: /api/health is CRON_SECRET-authenticated (see
// endpoint.server.ts), not public. An unsalted hash of a high-entropy
// secret is safe against a COLD brute-force attack regardless of who can
// see it, but it is NOT safe against an attacker who already possesses a
// CANDIDATE value from some other leak and wants to confirm whether that
// candidate matches production's current configuration — for that
// attacker, an exposed fingerprint is a free, unlimited oracle. The
// CRON_SECRET gate is the only thing standing between "anyone with a
// leaked key can silently confirm it's still live" and "only an operator
// who already holds the shared secret can check." If /api/health is ever
// made public or given a weaker auth model, THE FINGERPRINTS IN THIS
// SECTION MUST BE REMOVED FIRST, not left in place under a false sense of
// security because "it's just a hash."

import { createHash } from "node:crypto";

/** Server-only secrets worth drift-detecting: long, randomly-generated
 *  values where a truncated hash carries real (unsalted, see header)
 *  protection. Keep AGENT_MODEL and any other low-entropy/non-secret
 *  config OUT of this list — report those as plain values instead, the
 *  way check.server.ts already does for AGENT_MODEL. */
export const FINGERPRINTED_ENV_VARS = ["ANTHROPIC_API_KEY", "CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "FINNHUB_API_KEY", "TWELVEDATA_API_KEY"] as const;

export type FingerprintedVar = (typeof FINGERPRINTED_ENV_VARS)[number];

/** Unsalted SHA-256, first 8 hex chars — see this module's header for why
 *  that's the right, and sufficient, choice here. Returns null for an
 *  unset value so "not configured" and "configured, hash starts with a
 *  string that happens to look like a null-ish value" can never collide. */
export function fingerprint(value: string | undefined | null): string | null {
  if (!value) return null;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

export type FingerprintMap = Partial<Record<FingerprintedVar, string | null>>;

/** Computes a fingerprint per tracked variable from any `name -> value`
 *  reader — used identically by check.server.ts (reads process.env /
 *  local .env fallback via serverEnv) and check-config-fingerprint.ts
 *  (reads local .env the same way), so the two can never compute this
 *  differently by accident. */
export function computeFingerprints(readEnv: (name: string) => string | undefined): FingerprintMap {
  const out: FingerprintMap = {};
  for (const name of FINGERPRINTED_ENV_VARS) out[name] = fingerprint(readEnv(name));
  return out;
}

export type FingerprintDiffStatus = "match" | "mismatch" | "local-missing" | "remote-missing" | "both-missing";
export type FingerprintDiffRow = { name: FingerprintedVar; status: FingerprintDiffStatus; local: string | null; remote: string | null };

/** Pure comparison — no network here, so it's cheaply unit-testable
 *  separately from check-config-fingerprint.ts's actual HTTP fetch. */
export function diffFingerprints(local: FingerprintMap, remote: FingerprintMap): FingerprintDiffRow[] {
  return FINGERPRINTED_ENV_VARS.map((name) => {
    const l = local[name] ?? null;
    const r = remote[name] ?? null;
    let status: FingerprintDiffStatus;
    if (l === null && r === null) status = "both-missing";
    else if (l === null) status = "local-missing";
    else if (r === null) status = "remote-missing";
    else status = l === r ? "match" : "mismatch";
    return { name, status, local: l, remote: r };
  });
}
