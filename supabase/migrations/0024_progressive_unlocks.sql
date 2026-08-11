-- 0024_progressive_unlocks.sql
-- PLAN.md §6 step 8 (B3) — progressive unlocks for options and margin.
--
-- HARD PRINCIPLE, stated here because it belongs at the source of truth as
-- much as in code comments: unlocks are earned by demonstrating
-- comprehension, NEVER by winning. This is the entire reason PLAN.md §1
-- item 2 rejected "increase risk for users who are succeeding" — do not
-- reintroduce that idea by the back door. unlock_feature() below has no
-- path that reads cash_balance, returns, or any P&L figure, and never will.
--
-- Nullable timestamptz, not boolean+timestamp — matches terms_accepted_at's
-- own precedent (0022): null = locked, non-null = the moment they passed
-- the comprehension check (or were grandfathered — see below).
alter table public.profiles
  add column if not exists options_unlocked_at timestamptz,
  add column if not exists margin_unlocked_at timestamptz;

-- GRANDFATHERING is deliberately NOT a one-time backfill UPDATE here.
-- "Unlocked" is computed at READ time (lib/coaching/unlocks.ts) as
-- `options_unlocked_at IS NOT NULL OR the user has ever traded an option`
-- (and the equivalent for margin) — so any account with real prior
-- activity is automatically, permanently unlocked without needing this
-- migration to enumerate every existing user. Self-healing, and correct
-- for accounts created between this migration and the app-layer release.
--
-- Also deliberately untouched by resetPaperAccountFn (0015): resetting a
-- paper account wipes trading STATE, not the human's already-demonstrated
-- understanding of how options/margin work — comprehension doesn't regress
-- when a balance does.

-- unlock_feature — the ONLY way options_unlocked_at/margin_unlocked_at get
-- written. `profiles` has no bare UPDATE grant beyond `display_name`
-- (0012) — every other field is written exclusively through a SECURITY
-- DEFINER function, and this follows that same convention rather than
-- carving out a new grant. Idempotent: unlocking an already-unlocked
-- feature is a no-op that returns the ORIGINAL timestamp, never overwrites
-- it (so a user can't "re-unlock" to reset their own unlock date).
create or replace function public.unlock_feature(
  p_user_id uuid,
  p_feature text
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing timestamptz;
  v_now      timestamptz := now();
begin
  if p_feature not in ('options', 'margin') then
    raise exception 'invalid_feature';
  end if;

  if p_feature = 'options' then
    select options_unlocked_at into v_existing from public.profiles where id = p_user_id for update;
  else
    select margin_unlocked_at into v_existing from public.profiles where id = p_user_id for update;
  end if;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if v_existing is not null then
    return v_existing;
  end if;

  if p_feature = 'options' then
    update public.profiles set options_unlocked_at = v_now where id = p_user_id;
  else
    update public.profiles set margin_unlocked_at = v_now where id = p_user_id;
  end if;

  return v_now;
end;
$$;

revoke all on function public.unlock_feature(uuid, text) from public;
revoke all on function public.unlock_feature(uuid, text) from anon;
revoke all on function public.unlock_feature(uuid, text) from authenticated;
grant execute on function public.unlock_feature(uuid, text) to service_role;
