-- 0025_scenario_challenges.sql
-- PLAN.md §6 step 9 (B5) — scenario challenges ("Trade the 2008 crash").
--
-- ISOLATION: a scenario run is its OWN sub-portfolio, completely separate
-- from the user's real paper account — same pattern as the AI agent's
-- agent_config/agent_holdings/agent_transactions (0005_agent.sql,
-- 0006_agent_execute.sql). Nothing here ever touches `profiles`, `holdings`,
-- or `transactions`. Deliberately NOT wired into reset_paper_account (0015/
-- 0016) — a scenario run is its own universe, unaffected by resetting the
-- main account, exactly like agent_transactions/agent_decisions are kept
-- (not wiped) on reset.
--
-- Scenarios themselves (date range, starting stake, curated symbol set,
-- debrief copy) are CODE-DEFINED in lib/scenarios/catalog.ts, not DB rows —
-- there are only 3, curated, and rarely change. `scenario_id` here is a
-- plain text key matching that catalog.
--
-- NO-LOOK-AHEAD: `step_index` is the ENTIRE trust boundary for "how far
-- into the scenario has this user progressed" — it's written ONLY by
-- advance_scenario_step() below, server-side, and the TS layer (which owns
-- the code-defined scenario calendars) always re-derives and enforces the
-- REAL maximum index from the catalog before ever slicing candle data to
-- send to the browser. A client can advance the run (consuming it for
-- real, one direction only) but can never request a step_index directly.

create table if not exists public.scenario_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  scenario_id    text not null,
  status         text not null default 'active' check (status in ('active', 'completed')),
  cash           numeric not null,
  starting_cash  numeric not null,
  step_index     integer not null default 0,
  final_score    jsonb,
  started_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index if not exists scenario_runs_user_idx on public.scenario_runs (user_id, started_at desc);
-- At most one ACTIVE run per scenario per user — a DB-level backstop (the
-- SECURITY DEFINER function below also checks this explicitly for a
-- friendlier error), so a race can't create two active runs of the same
-- scenario.
create unique index if not exists scenario_runs_one_active_per_scenario
  on public.scenario_runs (user_id, scenario_id) where status = 'active';

alter table public.scenario_runs enable row level security;
drop policy if exists "scenario_runs_select_own" on public.scenario_runs;
create policy "scenario_runs_select_own" on public.scenario_runs
  for select using (auth.uid() = user_id);
grant select on public.scenario_runs to authenticated;
grant select, insert, update on public.scenario_runs to service_role;

create table if not exists public.scenario_holdings (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.scenario_runs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  quantity   numeric not null,
  avg_cost   numeric not null,
  updated_at timestamptz not null default now(),
  unique (run_id, symbol)
);
create index if not exists scenario_holdings_run_idx on public.scenario_holdings (run_id);
create index if not exists scenario_holdings_user_idx on public.scenario_holdings (user_id);
alter table public.scenario_holdings enable row level security;
drop policy if exists "scenario_holdings_select_own" on public.scenario_holdings;
create policy "scenario_holdings_select_own" on public.scenario_holdings
  for select using (auth.uid() = user_id);
grant select on public.scenario_holdings to authenticated;
grant select, insert, update, delete on public.scenario_holdings to service_role;

-- Append-only ledger, mirrors transactions/agent_transactions.
create table if not exists public.scenario_transactions (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.scenario_runs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  side       text not null check (side in ('buy', 'sell')),
  quantity   numeric not null,
  price      numeric not null,
  total      numeric not null,
  sim_date   date not null, -- the simulated in-scenario date this trade executed at (server-derived, never client input)
  created_at timestamptz not null default now() -- real wall-clock time
);
create index if not exists scenario_transactions_run_idx on public.scenario_transactions (run_id, sim_date);
create index if not exists scenario_transactions_user_idx on public.scenario_transactions (user_id, created_at desc);
alter table public.scenario_transactions enable row level security;
drop policy if exists "scenario_transactions_select_own" on public.scenario_transactions;
create policy "scenario_transactions_select_own" on public.scenario_transactions
  for select using (auth.uid() = user_id);
grant select on public.scenario_transactions to authenticated;
grant select, insert on public.scenario_transactions to service_role; -- append-only

-- ─────────────────────────────────────────────────────────────────────────
-- start_scenario_run — creates a fresh sub-portfolio for one scenario
-- attempt. Rejects a second concurrent active run of the same scenario
-- (friendly named exception; the unique index above is the hard backstop).
create or replace function public.start_scenario_run(
  p_user_id       uuid,
  p_scenario_id   text,
  p_starting_cash numeric
) returns public.scenario_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_row      public.scenario_runs;
begin
  if p_starting_cash is null or p_starting_cash <= 0 then
    raise exception 'invalid_starting_cash';
  end if;

  select id into v_existing from public.scenario_runs
    where user_id = p_user_id and scenario_id = p_scenario_id and status = 'active';
  if v_existing is not null then
    raise exception 'run_already_active';
  end if;

  insert into public.scenario_runs (user_id, scenario_id, cash, starting_cash, step_index, status)
    values (p_user_id, p_scenario_id, p_starting_cash, p_starting_cash, 0, 'active')
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.start_scenario_run(uuid, text, numeric) from public;
revoke all on function public.start_scenario_run(uuid, text, numeric) from anon;
revoke all on function public.start_scenario_run(uuid, text, numeric) from authenticated;
grant execute on function public.start_scenario_run(uuid, text, numeric) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- advance_scenario_step — the ONLY way step_index moves forward.
-- `p_max_index` is supplied by the TS caller, computed server-side from the
-- code-defined scenario catalog (never client input) — it clamps the
-- advance and flips status to 'completed' at the boundary. This is a
-- convenience clamp, not the actual no-look-ahead enforcement: the data-
-- fetch layer independently re-derives and enforces the real max index from
-- the same catalog before ever slicing candles for the browser, so a wrong
-- p_max_index here could only ever make a run finish early or fail to
-- finish — it can't be used to fabricate a shortcut to future prices.
create or replace function public.advance_scenario_step(
  p_user_id   uuid,
  p_run_id    uuid,
  p_steps     integer,
  p_max_index integer
) returns public.scenario_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.scenario_runs;
  v_new_index integer;
begin
  if p_steps is null or p_steps <= 0 then
    raise exception 'invalid_steps';
  end if;

  select * into v_row from public.scenario_runs
    where id = p_run_id and user_id = p_user_id for update;
  if not found then
    raise exception 'run_not_found';
  end if;
  if v_row.status <> 'active' then
    raise exception 'run_not_active';
  end if;

  v_new_index := least(v_row.step_index + p_steps, greatest(p_max_index, 0));

  update public.scenario_runs
    set step_index = v_new_index,
        status = case when v_new_index >= p_max_index then 'completed' else 'active' end,
        completed_at = case when v_new_index >= p_max_index then now() else completed_at end
    where id = p_run_id
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.advance_scenario_step(uuid, uuid, integer, integer) from public;
revoke all on function public.advance_scenario_step(uuid, uuid, integer, integer) from anon;
revoke all on function public.advance_scenario_step(uuid, uuid, integer, integer) from authenticated;
grant execute on function public.advance_scenario_step(uuid, uuid, integer, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- execute_scenario_trade — atomic buy/sell inside a scenario's own cash/
-- holdings, mirrors execute_trade/agent_execute_trade's exact structure and
-- weighted-avg-cost math. `p_price`/`p_sim_date` are computed server-side by
-- the caller (the current step's close, from the code-defined catalog +
-- cached candle series) — never trusted from the client.
create or replace function public.execute_scenario_trade(
  p_user_id  uuid,
  p_run_id   uuid,
  p_symbol   text,
  p_side     text,
  p_quantity numeric,
  p_price    numeric,
  p_sim_date date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol  text := upper(trim(p_symbol));
  v_run     public.scenario_runs;
  v_qty     numeric;
  v_avg     numeric;
  v_new_qty numeric;
  v_new_avg numeric;
  v_total   numeric;
begin
  if p_side not in ('buy', 'sell') then raise exception 'invalid_side'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'invalid_quantity'; end if;
  if p_price is null or p_price <= 0 then raise exception 'invalid_price'; end if;

  select * into v_run from public.scenario_runs
    where id = p_run_id and user_id = p_user_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if v_run.status <> 'active' then raise exception 'run_not_active'; end if;

  select quantity, avg_cost into v_qty, v_avg
    from public.scenario_holdings where run_id = p_run_id and symbol = v_symbol for update;

  if p_side = 'buy' then
    v_total := p_price * p_quantity;
    if v_total > v_run.cash then raise exception 'insufficient_cash'; end if;
    update public.scenario_runs set cash = cash - v_total where id = p_run_id returning cash into v_run.cash;
    if v_qty is null then
      v_new_qty := p_quantity;
      v_new_avg := p_price;
      insert into public.scenario_holdings (run_id, user_id, symbol, quantity, avg_cost, updated_at)
        values (p_run_id, p_user_id, v_symbol, v_new_qty, v_new_avg, now());
    else
      v_new_qty := v_qty + p_quantity;
      v_new_avg := ((v_qty * v_avg) + (p_quantity * p_price)) / v_new_qty;
      update public.scenario_holdings set quantity = v_new_qty, avg_cost = v_new_avg, updated_at = now()
        where run_id = p_run_id and symbol = v_symbol;
    end if;
  else
    if v_qty is null or p_quantity > v_qty then raise exception 'insufficient_shares'; end if;
    v_total := p_price * p_quantity;
    update public.scenario_runs set cash = cash + v_total where id = p_run_id returning cash into v_run.cash;
    v_new_qty := v_qty - p_quantity;
    if v_new_qty = 0 then
      delete from public.scenario_holdings where run_id = p_run_id and symbol = v_symbol;
      v_new_avg := null;
    else
      v_new_avg := v_avg;
      update public.scenario_holdings set quantity = v_new_qty, updated_at = now()
        where run_id = p_run_id and symbol = v_symbol;
    end if;
  end if;

  insert into public.scenario_transactions (run_id, user_id, symbol, side, quantity, price, total, sim_date)
    values (p_run_id, p_user_id, v_symbol, p_side, p_quantity, p_price, v_total, p_sim_date);

  return jsonb_build_object(
    'cash', v_run.cash, 'symbol', v_symbol, 'side', p_side,
    'quantity', p_quantity, 'price', p_price, 'total', v_total,
    'position_quantity', coalesce(v_new_qty, 0), 'position_avg_cost', v_new_avg
  );
end;
$$;

revoke all on function public.execute_scenario_trade(uuid, uuid, text, text, numeric, numeric, date) from public;
revoke all on function public.execute_scenario_trade(uuid, uuid, text, text, numeric, numeric, date) from anon;
revoke all on function public.execute_scenario_trade(uuid, uuid, text, text, numeric, numeric, date) from authenticated;
grant execute on function public.execute_scenario_trade(uuid, uuid, text, text, numeric, numeric, date) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- finalize_scenario_run — attaches the computed score (lib/scenarios/
-- scoring.ts, run server-side once the final candle data is fetched) to an
-- already-completed run. Idempotent: only writes if final_score is still
-- null, so re-viewing a completed run never overwrites its original score.
create or replace function public.finalize_scenario_run(
  p_user_id     uuid,
  p_run_id      uuid,
  p_final_score jsonb
) returns public.scenario_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.scenario_runs;
begin
  select * into v_row from public.scenario_runs
    where id = p_run_id and user_id = p_user_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if v_row.status <> 'completed' then raise exception 'run_not_completed'; end if;

  if v_row.final_score is null then
    update public.scenario_runs set final_score = p_final_score
      where id = p_run_id returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function public.finalize_scenario_run(uuid, uuid, jsonb) from public;
revoke all on function public.finalize_scenario_run(uuid, uuid, jsonb) from anon;
revoke all on function public.finalize_scenario_run(uuid, uuid, jsonb) from authenticated;
grant execute on function public.finalize_scenario_run(uuid, uuid, jsonb) to service_role;
