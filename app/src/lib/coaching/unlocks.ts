// PLAN.md §6 step 8 (B3) — pure unlock-status computation.
//
// Deliberately takes plain booleans/strings, not a Supabase client: this
// module must stay importable from both client and server code without
// pulling in any DB dependency (mirrors lib/behavioral/metrics.ts's
// pure-computation convention). The actual DB reads (does this profile have
// an options_unlocked_at? does this user have any option_transactions or
// margin_events rows?) live in queries.ts, which calls into this.
//
// GRANDFATHERING is a first-class, permanent outcome here, not a fallback:
// "reason: grandfathered" means the account had real historical activity in
// this domain before it ever saw a gate, and must never regress to locked.

export type UnlockReason = "quiz" | "grandfathered" | "locked";

export type UnlockStatus = {
  unlocked: boolean;
  reason: UnlockReason;
  /** When the unlock_feature() RPC recorded this — null for a grandfathered
   *  account (there was never a discrete "unlock moment" to record) or a
   *  still-locked one. */
  unlockedAt: string | null;
};

/**
 * @param unlockedAt   profiles.options_unlocked_at / margin_unlocked_at, as read from the DB.
 * @param hasPriorActivity   true if the user has ANY real historical activity in this
 *   domain (e.g. an option_transactions row, or having ever enabled margin) —
 *   computed by the caller from its own domain-specific query.
 */
export function computeUnlockStatus(unlockedAt: string | null, hasPriorActivity: boolean): UnlockStatus {
  if (unlockedAt !== null) {
    return { unlocked: true, reason: "quiz", unlockedAt };
  }
  if (hasPriorActivity) {
    return { unlocked: true, reason: "grandfathered", unlockedAt: null };
  }
  return { unlocked: false, reason: "locked", unlockedAt: null };
}
