-- 0010_options.sql
-- PaperTrader — Options & Margin epic, O2 (trade engine).
-- Long calls/puts only: buy_to_open, sell_to_close. Contract multiplier is
-- 100 (1 contract = 100 shares of notional exposure; premium × 100 per
-- contract). Mirrors the Phase 6 execute_trade architecture exactly:
-- atomic SECURITY DEFINER function, service_role-only EXECUTE, server-
-- computed premium (never client-supplied), append-only transaction ledger.
--
-- Idempotent: safe to re-run (create table if not exists, drop/create
-- policy, create or replace function, revoke/grant).

-- ──────────────────────────────────────────────────────────────
-- option_positions — current option holdings (one row per user per contract)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.option_positions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  contract_id  text not null,                    -- e.g. "NVDA-2026-09-18-C-200"
  symbol       text not null,
  opt_type     text not null check (opt_type in ('call', 'put')),
  strike       numeric not null,
  expiry       date not null,
  contracts    numeric not null,                 -- whole contracts, enforced by the function below
  avg_premium  numeric not null,                  -- weighted-average PER-CONTRACT premium (not ×100)
  opened_at    timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, contract_id)
);

create index if not exists option_positions_user_id_idx on public.option_positions (user_id);

alter table public.option_positions enable row level security;

drop policy if exists "option_positions_select_own" on public.option_positions;
create policy "option_positions_select_own" on public.option_positions
  for select using (auth.uid() = user_id);

-- Deliberately NO insert/update/delete policy for authenticated: positions
-- are managed EXCLUSIVELY by execute_option_trade (SECURITY DEFINER, called
-- with the service-role key) — never written directly by the client.
grant select on public.option_positions to authenticated;
grant select, insert, update, delete on public.option_positions to service_role;

-- ──────────────────────────────────────────────────────────────
-- option_transactions — immutable, append-only ledger of every options trade
-- ──────────────────────────────────────────────────────────────
create table if not exists public.option_transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  contract_id text not null,
  symbol      text not null,
  side        text not null check (side in ('buy_to_open', 'sell_to_close')),
  contracts   numeric not null,
  premium     numeric not null,                  -- PER-CONTRACT premium at fill (not ×100)
  total       numeric not null,                  -- premium × 100 × contracts
  created_at  timestamptz not null default now()
);

create index if not exists option_transactions_user_created_idx
  on public.option_transactions (user_id, created_at desc);

alter table public.option_transactions enable row level security;

drop policy if exists "option_transactions_select_own" on public.option_transactions;
create policy "option_transactions_select_own" on public.option_transactions
  for select using (auth.uid() = user_id);

drop policy if exists "option_transactions_insert_own" on public.option_transactions;
create policy "option_transactions_insert_own" on public.option_transactions
  for insert with check (auth.uid() = user_id);

-- Deliberately NO update/delete policy: the ledger is append-only, same as
-- the equities `transactions` table.
grant select, insert on public.option_transactions to authenticated;
grant select, insert on public.option_transactions to service_role;

-- ──────────────────────────────────────────────────────────────
-- execute_option_trade — atomic, race-safe buy_to_open / sell_to_close
-- ──────────────────────────────────────────────────────────────
--
-- SECURITY (identical model to execute_trade in 0003):
--   • EXECUTE is granted ONLY to service_role — never anon/authenticated —
--     so a browser can never call this directly. Reached only through the
--     server-side executeOptionTradeFn using the service-role key.
--   • Runs in ONE transaction (a function body is atomic) and locks the
--     user's profiles row (FOR UPDATE) to serialize concurrent trades,
--     plus the option_positions row for the same contract.
--   • The premium is supplied by the SERVER (computed via Black-Scholes
--     from a live spot + realized vol), never the client.
--   • Expired contracts (p_expiry < today) are rejected here too, as a
--     second, DB-level backstop behind the server function's own check.
create or replace function public.execute_option_trade(
  p_user_id     uuid,
  p_contract_id text,
  p_symbol      text,
  p_opt_type    text,
  p_strike      numeric,
  p_expiry      date,
  p_side        text,
  p_contracts   numeric,
  p_premium     numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol         text := upper(trim(p_symbol));
  v_contract_id    text := upper(trim(p_contract_id));
  v_cash           numeric;
  v_contracts      numeric;   -- existing position contracts (null if none)
  v_avg            numeric;   -- existing position avg premium
  v_new_contracts  numeric;
  v_new_avg        numeric;
  v_total          numeric;
begin
  -- ── Validation ──────────────────────────────────────────────
  if p_side not in ('buy_to_open', 'sell_to_close') then
    raise exception 'invalid_side';
  end if;
  if p_opt_type not in ('call', 'put') then
    raise exception 'invalid_opt_type';
  end if;
  if p_contracts is null or p_contracts <= 0 or p_contracts <> trunc(p_contracts) then
    raise exception 'invalid_contracts';
  end if;
  if p_premium is null or p_premium <= 0 then
    raise exception 'invalid_premium';
  end if;
  if p_expiry is null or p_expiry < current_date then
    raise exception 'expired_contract';
  end if;

  -- Lock the user's profile row so two concurrent trades can't race on cash.
  select cash_balance into v_cash
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  -- Lock the existing position (if any) too.
  select contracts, avg_premium into v_contracts, v_avg
  from public.option_positions
  where user_id = p_user_id and contract_id = v_contract_id
  for update;

  if p_side = 'buy_to_open' then
    v_total := p_premium * 100 * p_contracts;
    if v_total > v_cash then
      raise exception 'insufficient_funds';
    end if;

    update public.profiles
      set cash_balance = cash_balance - v_total
      where id = p_user_id
      returning cash_balance into v_cash;

    if v_contracts is null then
      v_new_contracts := p_contracts;
      v_new_avg := p_premium;
      insert into public.option_positions
        (user_id, contract_id, symbol, opt_type, strike, expiry, contracts, avg_premium, opened_at, updated_at)
        values (p_user_id, v_contract_id, v_symbol, p_opt_type, p_strike, p_expiry, v_new_contracts, v_new_avg, now(), now());
    else
      -- Weighted-average premium basis, same idea as equities' avg_cost.
      v_new_contracts := v_contracts + p_contracts;
      v_new_avg := ((v_contracts * v_avg) + (p_contracts * p_premium)) / v_new_contracts;
      update public.option_positions
        set contracts = v_new_contracts, avg_premium = v_new_avg, updated_at = now()
        where user_id = p_user_id and contract_id = v_contract_id;
    end if;

  else -- sell_to_close
    if v_contracts is null or p_contracts > v_contracts then
      raise exception 'insufficient_contracts';
    end if;

    v_total := p_premium * 100 * p_contracts;
    update public.profiles
      set cash_balance = cash_balance + v_total
      where id = p_user_id
      returning cash_balance into v_cash;

    v_new_contracts := v_contracts - p_contracts;
    if v_new_contracts = 0 then
      delete from public.option_positions where user_id = p_user_id and contract_id = v_contract_id;
      v_new_avg := null;
    else
      v_new_avg := v_avg; -- avg premium is unchanged by a sell (mirrors avg_cost on a stock sell)
      update public.option_positions
        set contracts = v_new_contracts, updated_at = now()
        where user_id = p_user_id and contract_id = v_contract_id;
    end if;
  end if;

  -- Append to the immutable ledger.
  insert into public.option_transactions (user_id, contract_id, symbol, side, contracts, premium, total)
    values (p_user_id, v_contract_id, v_symbol, p_side, p_contracts, p_premium, v_total);

  return jsonb_build_object(
    'cash_balance',        v_cash,
    'contract_id',         v_contract_id,
    'symbol',               v_symbol,
    'side',                 p_side,
    'contracts',            p_contracts,
    'premium',              p_premium,
    'total',                v_total,
    'position_contracts',   coalesce(v_new_contracts, 0),
    'position_avg_premium', v_new_avg
  );
end;
$$;

-- Lock the function down: callable only by service_role (server-side).
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric) from public;
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric) from anon;
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric) from authenticated;
grant execute on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric) to service_role;
