-- 0007_agent_snapshots.sql
-- PaperTrader — Phase 10.4 (Agent dashboard).
-- Daily value history for the AI agent's SEPARATE sub-portfolio, powering the
-- agent value chart + day-over-day return. One row per user per day.
--
-- Written SERVER-SIDE only by the snapshot writer (service-role; same cron as
-- the main portfolio snapshots). Clients may SELECT their own rows, never write.
--
-- total_value = agent_cash + Σ(agent_holding.qty × price). Idempotent.

create table if not exists public.agent_snapshots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  total_value    numeric not null,
  agent_cash     numeric not null,
  holdings_value numeric not null,
  captured_at    date not null default current_date,
  unique (user_id, captured_at)
);

create index if not exists agent_snapshots_user_captured_idx
  on public.agent_snapshots (user_id, captured_at);

alter table public.agent_snapshots enable row level security;

-- Owner can read their own agent snapshots (for the chart). No client writes.
drop policy if exists "agent_snapshots_select_own" on public.agent_snapshots;
create policy "agent_snapshots_select_own" on public.agent_snapshots
  for select using (auth.uid() = user_id);

grant select on public.agent_snapshots to authenticated;

-- The snapshot writer runs as service_role (server-only): it reads agent_config
-- + agent_holdings and writes agent_snapshots.
grant select, insert, update on public.agent_snapshots to service_role;
grant select on public.agent_config   to service_role;
grant select on public.agent_holdings to service_role;

-- Seed a chart ORIGIN for funded agents: their allocated amount (all cash, no
-- holdings) on the day the agent was set up. A real reference point — the agent
-- starts at whatever you funded it with. Unfunded agents get nothing until the
-- writer runs after they hold value.
insert into public.agent_snapshots (user_id, total_value, agent_cash, holdings_value, captured_at)
  select user_id, allocated_total, allocated_total, 0, created_at::date
  from public.agent_config
  where allocated_total > 0
  on conflict (user_id, captured_at) do nothing;
