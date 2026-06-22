-- 0005_agent.sql
-- PaperTrader — Phase 10.1 (AI Portfolio Agent foundations).
-- A SEPARATE virtual sub-portfolio the agent manages, funded from the user's
-- existing virtual cash (profiles.cash_balance). Isolated from the user's
-- manual holdings/transactions. PAPER MONEY ONLY — educational simulation.
--
-- Owner-only RLS on every table. Writes happen server-side (service_role) via
-- server functions; clients only SELECT their own rows. Idempotent.

-- ──────────────────────────────────────────────────────────────
-- agent_config — one row per user (the agent's settings + cash)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.agent_config (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  enabled         boolean not null default false,
  mode            text not null default 'autonomous' check (mode in ('autonomous', 'approve')),
  risk_level      text not null default 'balanced' check (risk_level in ('conservative', 'balanced', 'aggressive')),
  agent_cash      numeric not null default 0,   -- spendable cash inside the agent sub-portfolio
  allocated_total numeric not null default 0,   -- net capital the user has moved into the agent
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.agent_config enable row level security;
drop policy if exists "agent_config_select_own" on public.agent_config;
create policy "agent_config_select_own" on public.agent_config
  for select using (auth.uid() = user_id);
grant select on public.agent_config to authenticated;
grant select, insert, update on public.agent_config to service_role;

-- ──────────────────────────────────────────────────────────────
-- agent_holdings — the agent's positions (one row per user per symbol)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.agent_holdings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  symbol              text not null,
  quantity            numeric not null,
  avg_cost            numeric not null,
  trailing_stop_price numeric,
  updated_at          timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists agent_holdings_user_idx on public.agent_holdings (user_id);

alter table public.agent_holdings enable row level security;
drop policy if exists "agent_holdings_select_own" on public.agent_holdings;
create policy "agent_holdings_select_own" on public.agent_holdings
  for select using (auth.uid() = user_id);
grant select on public.agent_holdings to authenticated;
grant select, insert, update, delete on public.agent_holdings to service_role;

-- ──────────────────────────────────────────────────────────────
-- agent_transactions — append-only ledger of the agent's trades
-- ──────────────────────────────────────────────────────────────
create table if not exists public.agent_transactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  side       text not null check (side in ('buy', 'sell')),
  quantity   numeric not null,
  price      numeric not null,
  total      numeric not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists agent_transactions_user_created_idx
  on public.agent_transactions (user_id, created_at desc);

alter table public.agent_transactions enable row level security;
drop policy if exists "agent_transactions_select_own" on public.agent_transactions;
create policy "agent_transactions_select_own" on public.agent_transactions
  for select using (auth.uid() = user_id);
grant select on public.agent_transactions to authenticated;
grant select, insert on public.agent_transactions to service_role; -- append-only

-- ──────────────────────────────────────────────────────────────
-- agent_decisions — append-only plain-English decision log
-- ──────────────────────────────────────────────────────────────
create table if not exists public.agent_decisions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  action     text not null,
  symbol     text,
  rationale  text,
  signals    jsonb
);
create index if not exists agent_decisions_user_created_idx
  on public.agent_decisions (user_id, created_at desc);

alter table public.agent_decisions enable row level security;
drop policy if exists "agent_decisions_select_own" on public.agent_decisions;
create policy "agent_decisions_select_own" on public.agent_decisions
  for select using (auth.uid() = user_id);
grant select on public.agent_decisions to authenticated;
grant select, insert on public.agent_decisions to service_role; -- append-only

-- ──────────────────────────────────────────────────────────────
-- fund_agent — atomically move virtual cash main ↔ agent
--   p_amount > 0  → fund:     profiles.cash_balance → agent_cash
--   p_amount < 0  → withdraw: agent_cash → profiles.cash_balance
-- Locks the profiles row; rejects overfunding/overwithdrawing.
-- EXECUTE granted only to service_role (reached via the admin server client).
-- ──────────────────────────────────────────────────────────────
create or replace function public.fund_agent(p_user_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash      numeric;
  v_agent     numeric;
  v_allocated numeric;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'invalid_amount';
  end if;

  -- Lock the user's main cash row to serialize concurrent moves.
  select cash_balance into v_cash from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'profile_not_found';
  end if;

  -- Ensure an agent_config row exists, then lock it.
  insert into public.agent_config (user_id) values (p_user_id)
    on conflict (user_id) do nothing;
  select agent_cash, allocated_total into v_agent, v_allocated
    from public.agent_config where user_id = p_user_id for update;

  if p_amount > 0 then
    if p_amount > v_cash then
      raise exception 'insufficient_cash';
    end if;
    update public.profiles set cash_balance = cash_balance - p_amount where id = p_user_id
      returning cash_balance into v_cash;
    update public.agent_config
      set agent_cash = agent_cash + p_amount,
          allocated_total = allocated_total + p_amount,
          updated_at = now()
      where user_id = p_user_id
      returning agent_cash, allocated_total into v_agent, v_allocated;
  else
    -- withdrawal
    if (-p_amount) > v_agent then
      raise exception 'insufficient_agent_cash';
    end if;
    update public.profiles set cash_balance = cash_balance + (-p_amount) where id = p_user_id
      returning cash_balance into v_cash;
    update public.agent_config
      set agent_cash = agent_cash + p_amount,                       -- p_amount is negative
          allocated_total = greatest(0, allocated_total + p_amount),
          updated_at = now()
      where user_id = p_user_id
      returning agent_cash, allocated_total into v_agent, v_allocated;
  end if;

  return jsonb_build_object(
    'cash_balance', v_cash,
    'agent_cash', v_agent,
    'allocated_total', v_allocated
  );
end;
$$;

revoke all on function public.fund_agent(uuid, numeric) from public;
revoke all on function public.fund_agent(uuid, numeric) from anon;
revoke all on function public.fund_agent(uuid, numeric) from authenticated;
grant execute on function public.fund_agent(uuid, numeric) to service_role;
