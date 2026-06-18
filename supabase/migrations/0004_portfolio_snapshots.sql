-- 0004_portfolio_snapshots.sql
-- PaperTrader — Phase 8 (live tracking).
-- Daily portfolio-value history that powers the Dashboard value chart and the
-- total-return numbers. One row per user per day.
--
-- Rows are written SERVER-SIDE only, by the snapshot writer using the
-- service-role client (Vercel Cron triggers it in Phase 9). Clients may SELECT
-- their own rows (for the chart) but never insert/update.
--
-- Idempotent: safe to re-run.

create table if not exists public.portfolio_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  total_value    numeric not null,
  cash           numeric not null,
  holdings_value numeric not null,
  captured_at    date not null default current_date,
  unique (user_id, captured_at)
);

create index if not exists portfolio_snapshots_user_captured_idx
  on public.portfolio_snapshots (user_id, captured_at);

alter table public.portfolio_snapshots enable row level security;

-- Owner can read their own snapshots (for the chart). No client writes.
drop policy if exists "snapshots_select_own" on public.portfolio_snapshots;
create policy "snapshots_select_own" on public.portfolio_snapshots
  for select using (auth.uid() = user_id);

grant select on public.portfolio_snapshots to authenticated;

-- The snapshot writer runs as service_role (server-only). It bypasses RLS but
-- needs explicit table privileges on this project ("auto-grant" is off): it
-- reads profiles + holdings and writes snapshots.
grant select, insert, update on public.portfolio_snapshots to service_role;
grant select on public.profiles  to service_role;
grant select on public.holdings  to service_role;

-- Seed a sensible chart ORIGIN for existing users: their starting $100,000 on
-- the day the account was created. This is a real reference point (everyone
-- starts at $100k), not fabricated history. New users get this from the writer.
insert into public.portfolio_snapshots (user_id, total_value, cash, holdings_value, captured_at)
  select id, 100000, 100000, 0, created_at::date
  from public.profiles
  on conflict (user_id, captured_at) do nothing;
