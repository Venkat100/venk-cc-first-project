-- A4: proof of legal consent, recorded server-side at signup. This is a DATA
-- INTEGRITY guarantee, not a security control: raw_user_meta_data is
-- client-supplied (set via signUp()'s options.data), so a scripted client
-- could still populate terms_accepted_version with any value it wants — the
-- gate does not stop a determined bad actor from claiming consent. What it
-- DOES guarantee is that no profile can exist without SOME consent record,
-- because handle_new_user() now REQUIRES raw_user_meta_data ->>
-- 'terms_accepted_version' and RAISE EXCEPTIONs (aborting the whole
-- auth.users INSERT) if it's absent — so a bug in our own signup form that
-- silently drops the field fails loudly instead of quietly creating
-- unconsented accounts.

alter table public.profiles
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text;

-- Existing accounts (created before this migration) simply keep these NULL —
-- consistent with how starting_capital handled pre-existing accounts: no
-- retroactive re-consent is required, this is a signup-time-only gate.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terms_version text := new.raw_user_meta_data ->> 'terms_accepted_version';
begin
  if v_terms_version is null or v_terms_version = '' then
    raise exception 'terms_not_accepted: signup requires terms_accepted_version in user metadata';
  end if;

  insert into public.profiles (id, display_name, cash_balance, starting_capital, terms_accepted_at, terms_version)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    25000,
    25000,
    now(),
    v_terms_version
  )
  on conflict (id) do nothing;

  insert into public.analytics_events (user_id, event) values (new.id, 'signup');

  return new;
end;
$$;
