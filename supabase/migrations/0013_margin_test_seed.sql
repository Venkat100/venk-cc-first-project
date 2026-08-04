-- 0013_margin_test_seed.sql
-- Follow-up to 0012, found while writing the M1 live-verification script.
--
-- ROOT CAUSE OF A DISCOVERED GAP (not a bug — a previously-untested
-- assumption): `service_role` has NEVER had a table-level UPDATE grant on
-- `public.profiles` — migration 0001 only ever granted `select, update` to
-- `authenticated`. Every legitimate production write to profiles (cash,
-- margin_loan, margin_status, etc.) goes through the SECURITY DEFINER
-- functions in 0003/0012, which run as the FUNCTION OWNER and never needed
-- the caller's own table grants — so this has always been correct,
-- defense-in-depth behavior: even the service-role key can't casually
-- clobber a money column outside a vetted, event-logged function. Confirmed
-- live: `admin.from("profiles").update(...)` returns Postgres 42501
-- "permission denied for table profiles" with the hint "GRANT UPDATE ON
-- public.profiles TO service_role" — i.e. exactly the missing grant, not an
-- RLS issue and not a stuck lock.
--
-- That's GOOD security posture, so the fix is NOT to broad-grant UPDATE on
-- profiles to service_role (that would be a real regression). Instead, this
-- adds ONE narrow, service_role-only, SECURITY DEFINER seam — mirroring how
-- 0010 already solved the identical "verification needs to reach an
-- otherwise-unreachable state" problem for option_positions (an explicit
-- service_role grant there; a function here, since it's tighter — input-
-- validated, no arbitrary column access). Scoped to exactly the two columns
-- M1 verification needs to seed: `margin_loan` (to engineer a deterministic
-- margin-call/warning scenario without waiting on a real price crash) and
-- `last_interest_accrued_at` (to backdate the interest watermark, since
-- set_margin_enabled always stamps it to TODAY on enable — there is no
-- legitimate same-day path to a nonzero accrual). Deliberately EXCLUDES
-- cash_balance and margin_enabled/margin_status — nothing here can move
-- money or flip the opt-in flag.
create or replace function public.admin_seed_margin_state(
  p_user_id                    uuid,
  p_margin_loan                numeric default null,
  p_last_interest_accrued_at   date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan numeric;
  v_last date;
begin
  update public.profiles
    set margin_loan = coalesce(p_margin_loan, margin_loan),
        last_interest_accrued_at = coalesce(p_last_interest_accrued_at, last_interest_accrued_at)
    where id = p_user_id
    returning margin_loan, last_interest_accrued_at into v_loan, v_last;

  if not found then
    raise exception 'profile_not_found';
  end if;

  return jsonb_build_object('margin_loan', v_loan, 'last_interest_accrued_at', v_last);
end;
$$;

revoke all on function public.admin_seed_margin_state(uuid, numeric, date) from public;
revoke all on function public.admin_seed_margin_state(uuid, numeric, date) from anon;
revoke all on function public.admin_seed_margin_state(uuid, numeric, date) from authenticated;
grant execute on function public.admin_seed_margin_state(uuid, numeric, date) to service_role;
