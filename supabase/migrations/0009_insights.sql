-- 0009_insights.sql
-- PaperTrader — AI Insights.
--
-- Stores BOTH kinds of AI output durably, because production is Vercel
-- serverless: module memory does NOT survive invocations, so an in-memory-only
-- day cache would miss constantly and leak a paid Claude call per click.
--
--   kind='stock' — per-symbol insight, SHARED across all users (the content has
--                  no user data), user_id NULL, symbol set. One row per symbol
--                  per day globally ⇒ at most ONE Claude call per symbol per day.
--   kind='brief' — per-user daily market brief, user_id set, symbol NULL.
--                  One row per user per day.
--
-- Written SERVER-SIDE only (service_role). Idempotent — safe to re-run, and it
-- repairs an earlier shape of this table if one was already applied.

create table if not exists public.insights (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users (id) on delete cascade, -- NULL for kind='stock'
  kind       text not null,
  symbol     text,                                              -- NULL for kind='brief'
  payload    jsonb not null,
  created_at date not null default current_date
);

-- Repair path if an earlier (user-only) version of this table exists.
alter table public.insights alter column user_id drop not null;
alter table public.insights add column if not exists symbol text;
alter table public.insights drop constraint if exists insights_user_id_kind_created_at_key;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'insights_kind_check') then
    alter table public.insights add constraint insights_kind_check check (kind in ('stock', 'brief'));
  end if;
end $$;

-- Uniqueness per kind (partial unique indexes):
--   one shared insight per SYMBOL per day; one brief per USER per day.
create unique index if not exists insights_stock_daily_uidx
  on public.insights (symbol, created_at) where kind = 'stock';
create unique index if not exists insights_brief_daily_uidx
  on public.insights (user_id, created_at) where kind = 'brief';

create index if not exists insights_lookup_idx
  on public.insights (kind, created_at desc);

alter table public.insights enable row level security;

-- Signed-in users may read ANY kind='stock' row (it contains no user data) and
-- only their OWN kind='brief' rows. No client writes.
drop policy if exists "insights_select_own" on public.insights;
drop policy if exists "insights_select_stock_or_own_brief" on public.insights;
create policy "insights_select_stock_or_own_brief" on public.insights
  for select using (kind = 'stock' or auth.uid() = user_id);

grant select on public.insights to authenticated;

-- The insight generator + brief job run as service_role: they read each user's
-- holdings + watchlist and write both kinds of insight. (holdings was granted in
-- 0004; watchlist was not — grant it here.)
grant select, insert, update on public.insights  to service_role;
grant select on public.watchlist to service_role;
