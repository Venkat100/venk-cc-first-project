-- 0001_init_profiles.sql
-- PaperTrader — Phase 3 (auth). Creates the `profiles` table, locks it down
-- with Row-Level Security, and auto-seeds every new user with $100,000.
--
-- Safe to run more than once (idempotent guards throughout).
-- Apply via the Supabase dashboard SQL Editor, or `supabase db push` once the
-- CLI is linked. See supabase/README.md.

-- ──────────────────────────────────────────────────────────────
-- 1) profiles table  (one row per auth user)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  cash_balance numeric not null default 100000,
  created_at   timestamptz not null default now()
);

comment on table public.profiles is
  'One row per user. cash_balance is virtual buying power, seeded at 100000.';

-- ──────────────────────────────────────────────────────────────
-- 2) Row-Level Security: a user can see/update ONLY their own row
-- ──────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

drop policy if exists "Profiles are viewable by owner" on public.profiles;
create policy "Profiles are viewable by owner"
  on public.profiles
  for select
  using (auth.uid() = id);

drop policy if exists "Profiles are updatable by owner" on public.profiles;
create policy "Profiles are updatable by owner"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No client INSERT/DELETE policy on purpose: rows are created by the
-- handle_new_user trigger below (runs as SECURITY DEFINER), never by the
-- browser. cash_balance therefore can't be set by the client at signup.

-- ──────────────────────────────────────────────────────────────
-- 3) Privileges  (this project has "auto-expose new tables" OFF, so grant
--    table access explicitly; RLS above still restricts to the owner's row)
-- ──────────────────────────────────────────────────────────────
grant select, update on public.profiles to authenticated;

-- ──────────────────────────────────────────────────────────────
-- 4) Auto-create a profile when a new auth user signs up
-- ──────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, cash_balance)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    100000
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
