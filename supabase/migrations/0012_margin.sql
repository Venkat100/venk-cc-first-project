-- 0012_margin.sql
-- PaperTrader — Options & Margin epic, M1 (margin engine, server-side only —
-- UI is M2). Educational simulation of Reg-T-style margin: opt-in 2× lever-
-- age, a maintenance requirement, daily interest, and simulated margin
-- calls with forced liquidation. Same architecture discipline as every other
-- money path in this schema: atomic SECURITY DEFINER functions, service_
-- role-only EXECUTE, all state changes row-locked.
--
-- FORMULAS (documented here as the single source of truth — code comments in
-- lib/margin/* restate these, not redefine them):
--   positions_value = stock holdings market value + option positions market
--                      value (both live-priced server-side, never a client
--                      number, never a stale cached one for a money decision)
--   equity           = cash + positions_value − margin_loan
--   buying_power     = margin_enabled
--                         ? greatest(0, 2 × equity − positions_value)   -- 2:1
--                           leverage, a simplified simulation of Reg-T's 50%
--                           initial margin requirement — NOT a real broker's
--                           actual rule set (no per-security nuance, no
--                           portfolio margin, no special cases)
--                         : cash                                        -- OFF
--                           behaves EXACTLY like today: buying power = cash,
--                           nothing else about a trade's math changes.
--   maintenance_req  = positions_value × 0.30 (a common broker-ish level;
--                       documented choice, not FINRA's literal 25% floor —
--                       see lib/margin/config.server.ts)
--   MARGIN CALL       when equity < maintenance_req
--   'warning'         when equity < maintenance_req × 1.10 (10% buffer —
--                       a heads-up before an actual call; see config)
--   daily interest    margin_loan × (annual rate ÷ 365), simple daily
--                       accrual, ADDED TO THE LOAN (not charged to cash) —
--                       chosen because a margin loan compounding is the
--                       realistic behavior (real brokers capitalize margin
--                       interest into the loan balance too); charging cash
--                       instead could push cash negative with no borrowing
--                       relationship to fix it, which would be a modeling
--                       inconsistency.
--
-- Idempotent: safe to re-run.

-- ──────────────────────────────────────────────────────────────
-- 1) profiles — margin fields (a NEW table was considered and rejected: the
--    agent's sub-portfolio lives in a separate table because it's a
--    genuinely separate portfolio with its own cash; margin is a property of
--    the SAME main account profiles already models with cash_balance, and
--    keeping it there means every money-moving function still only needs to
--    lock ONE row (profiles) for cash+loan consistency, not coordinate
--    locks across two tables.)
-- ──────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists margin_enabled boolean not null default false;
alter table public.profiles add column if not exists margin_loan numeric not null default 0;
alter table public.profiles add column if not exists margin_status text not null default 'ok';
alter table public.profiles add column if not exists last_interest_accrued_at date;

alter table public.profiles drop constraint if exists profiles_margin_status_check;
alter table public.profiles add constraint profiles_margin_status_check
  check (margin_status in ('ok', 'warning', 'call'));

-- 🔧 SECURITY FIX (found in passing, while adding money-bearing columns to a
-- table the client already has a blanket UPDATE grant on): profiles has
-- carried `grant update on public.profiles to authenticated` since Phase 3,
-- restricted by RLS to WHICH ROW (`auth.uid() = id`) but NOT which COLUMN —
-- meaning a client could already PATCH their own cash_balance directly via
-- PostgREST, bypassing execute_trade entirely. Adding margin_loan/margin_
-- enabled/margin_status to the SAME table under the SAME blanket grant would
-- extend that exact gap to the new money-critical columns. Fixed with
-- column-level privileges instead: the ONLY legitimate direct client write
-- to this table is Settings' display_name self-edit (verified against the
-- actual client code before writing this) — so revoke the blanket grant and
-- re-grant UPDATE on display_name alone. cash_balance/margin_* now require
-- going through a SECURITY DEFINER function, same as everything else here.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ──────────────────────────────────────────────────────────────
-- margin_events — append-only audit of every margin-related state change
-- ──────────────────────────────────────────────────────────────
create table if not exists public.margin_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('enabled', 'disabled', 'borrow', 'repay', 'interest', 'warning', 'call', 'liquidation')),
  amount     numeric not null default 0,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index if not exists margin_events_user_created_idx
  on public.margin_events (user_id, created_at desc);

alter table public.margin_events enable row level security;

drop policy if exists "margin_events_select_own" on public.margin_events;
create policy "margin_events_select_own" on public.margin_events
  for select using (auth.uid() = user_id);

-- Deliberately NO insert/update/delete policy for authenticated: every row
-- is written EXCLUSIVELY by the SECURITY DEFINER functions below, via
-- service_role — same "owner-only RLS select; service_role writes" pattern
-- as option_positions (0010).
grant select on public.margin_events to authenticated;
grant select, insert on public.margin_events to service_role;

-- ──────────────────────────────────────────────────────────────
-- margin_buying_power — pure formula helper, shared by execute_trade and
-- execute_option_trade so the two can never compute buying power differently
-- ──────────────────────────────────────────────────────────────
create or replace function public.margin_buying_power(
  p_cash             numeric,
  p_margin_loan      numeric,
  p_margin_enabled   boolean,
  p_positions_value  numeric
) returns numeric
language sql
immutable
as $$
  select case
    when not p_margin_enabled then p_cash
    else greatest(0, 2 * (p_cash + p_positions_value - p_margin_loan) - p_positions_value)
  end;
$$;

revoke all on function public.margin_buying_power(numeric, numeric, boolean, numeric) from public;
revoke all on function public.margin_buying_power(numeric, numeric, boolean, numeric) from anon;
revoke all on function public.margin_buying_power(numeric, numeric, boolean, numeric) from authenticated;
grant execute on function public.margin_buying_power(numeric, numeric, boolean, numeric) to service_role;

-- ──────────────────────────────────────────────────────────────
-- set_margin_enabled — opt in/out. Disabling is REJECTED while a loan is
-- outstanding (must repay first) — this function must be structurally
-- unable to leave a loan "orphaned" with margin turned off.
-- ──────────────────────────────────────────────────────────────
create or replace function public.set_margin_enabled(
  p_user_id uuid,
  p_enabled boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan    numeric;
  v_enabled boolean;
begin
  select margin_loan, margin_enabled into v_loan, v_enabled
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if p_enabled = v_enabled then
    return jsonb_build_object('margin_enabled', v_enabled, 'margin_loan', v_loan); -- idempotent no-op
  end if;

  if not p_enabled and v_loan > 0 then
    raise exception 'loan_outstanding';
  end if;

  update public.profiles
    set margin_enabled = p_enabled,
        margin_status = 'ok',
        last_interest_accrued_at = case when p_enabled then current_date else last_interest_accrued_at end
    where id = p_user_id;

  insert into public.margin_events (user_id, kind, amount, detail)
    values (p_user_id, case when p_enabled then 'enabled' else 'disabled' end, 0, null);

  return jsonb_build_object('margin_enabled', p_enabled, 'margin_loan', v_loan);
end;
$$;

revoke all on function public.set_margin_enabled(uuid, boolean) from public;
revoke all on function public.set_margin_enabled(uuid, boolean) from anon;
revoke all on function public.set_margin_enabled(uuid, boolean) from authenticated;
grant execute on function public.set_margin_enabled(uuid, boolean) to service_role;

-- ──────────────────────────────────────────────────────────────
-- accrue_margin_interest — idempotent PER DAY (checks last_interest_
-- accrued_at, not just "run once ever") so a cron re-run or a retry never
-- double-charges. No-ops cleanly (still stamps the date) when there's no
-- loan to accrue interest on.
-- ──────────────────────────────────────────────────────────────
create or replace function public.accrue_margin_interest(
  p_user_id uuid,
  p_rate    numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan     numeric;
  v_last     date;
  v_interest numeric;
begin
  select margin_loan, last_interest_accrued_at into v_loan, v_last
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  if v_last = current_date then
    return jsonb_build_object('accrued', false, 'margin_loan', v_loan, 'interest', 0); -- already ran today
  end if;

  if v_loan <= 0 then
    update public.profiles set last_interest_accrued_at = current_date where id = p_user_id;
    return jsonb_build_object('accrued', false, 'margin_loan', v_loan, 'interest', 0);
  end if;

  v_interest := round(v_loan * p_rate / 365, 2);

  update public.profiles
    set margin_loan = margin_loan + v_interest,
        last_interest_accrued_at = current_date
    where id = p_user_id
    returning margin_loan into v_loan;

  insert into public.margin_events (user_id, kind, amount, detail)
    values (p_user_id, 'interest', v_interest, jsonb_build_object('rate', p_rate));

  return jsonb_build_object('accrued', true, 'margin_loan', v_loan, 'interest', v_interest);
end;
$$;

revoke all on function public.accrue_margin_interest(uuid, numeric) from public;
revoke all on function public.accrue_margin_interest(uuid, numeric) from anon;
revoke all on function public.accrue_margin_interest(uuid, numeric) from authenticated;
grant execute on function public.accrue_margin_interest(uuid, numeric) to service_role;

-- ──────────────────────────────────────────────────────────────
-- repay_margin — manual paydown, capped at min(requested, cash, loan) so it
-- can never overdraw cash or overpay the loan.
-- ──────────────────────────────────────────────────────────────
create or replace function public.repay_margin(
  p_user_id uuid,
  p_amount  numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash   numeric;
  v_loan   numeric;
  v_repay  numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount';
  end if;

  select cash_balance, margin_loan into v_cash, v_loan
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  v_repay := least(p_amount, v_cash, v_loan);
  if v_repay <= 0 then
    raise exception 'nothing_to_repay';
  end if;

  update public.profiles
    set cash_balance = cash_balance - v_repay,
        margin_loan  = margin_loan - v_repay,
        margin_status = case when margin_loan - v_repay <= 0 then 'ok' else margin_status end
    where id = p_user_id
    returning cash_balance, margin_loan into v_cash, v_loan;

  insert into public.margin_events (user_id, kind, amount, detail)
    values (p_user_id, 'repay', v_repay, jsonb_build_object('manual', true, 'requested', p_amount));

  return jsonb_build_object('cash_balance', v_cash, 'margin_loan', v_loan, 'repaid', v_repay);
end;
$$;

revoke all on function public.repay_margin(uuid, numeric) from public;
revoke all on function public.repay_margin(uuid, numeric) from anon;
revoke all on function public.repay_margin(uuid, numeric) from authenticated;
grant execute on function public.repay_margin(uuid, numeric) to service_role;

-- ══════════════════════════════════════════════════════════════
-- execute_trade — updated for margin (0003 → this). Signature GAINS a new
-- final parameter (p_positions_value), so the OLD 5-arg overload must be
-- dropped explicitly — CREATE OR REPLACE with a different parameter list
-- creates a SECOND overload rather than replacing the first, which would
-- leave a stale, differently-behaved function reachable.
--
-- MARGIN-OFF BEHAVIOR IS UNCHANGED BY CONSTRUCTION: margin_buying_power()
-- returns exactly `cash` when margin_enabled is false, so the buy check
-- (`v_total > v_buying_power`) degrades to today's `v_total > v_cash`
-- exactly; margin_loan stays 0 (borrowed = greatest(0, v_total - v_cash) = 0
-- whenever v_total ≤ cash, which the check already guarantees), so
-- cash_used = v_total and the update is bit-for-bit what it always was. On
-- sell, loan_repaid = least(v_total, 0) = 0 whenever there's no loan, so all
-- proceeds go to cash exactly as before. Verified explicitly, not just
-- argued — see the changelog entry's margin-off regression suite.
-- ══════════════════════════════════════════════════════════════
drop function if exists public.execute_trade(uuid, text, text, numeric, numeric);

create or replace function public.execute_trade(
  p_user_id          uuid,
  p_symbol           text,
  p_side             text,
  p_quantity         numeric,
  p_price            numeric,
  p_positions_value  numeric default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol         text := upper(trim(p_symbol));
  v_cash           numeric;
  v_margin_loan    numeric;
  v_margin_enabled boolean;
  v_buying_power   numeric;
  v_cash_used      numeric;
  v_borrowed       numeric;
  v_loan_repaid    numeric;
  v_cash_credit    numeric;
  v_qty            numeric;
  v_avg            numeric;
  v_new_qty        numeric;
  v_new_avg        numeric;
  v_total          numeric;
begin
  if p_side not in ('buy', 'sell') then
    raise exception 'invalid_side';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'invalid_quantity';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'invalid_price';
  end if;

  select cash_balance, margin_loan, margin_enabled
    into v_cash, v_margin_loan, v_margin_enabled
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  select quantity, avg_cost into v_qty, v_avg
  from public.holdings
  where user_id = p_user_id and symbol = v_symbol
  for update;

  if p_side = 'buy' then
    v_total := p_price * p_quantity;
    v_buying_power := public.margin_buying_power(v_cash, v_margin_loan, v_margin_enabled, coalesce(p_positions_value, 0));
    if v_total > v_buying_power then
      raise exception 'insufficient_funds';
    end if;

    v_cash_used := least(v_total, v_cash);
    v_borrowed := greatest(0, v_total - v_cash);

    update public.profiles
      set cash_balance = cash_balance - v_cash_used,
          margin_loan  = margin_loan + v_borrowed
      where id = p_user_id
      returning cash_balance, margin_loan into v_cash, v_margin_loan;

    if v_borrowed > 0 then
      insert into public.margin_events (user_id, kind, amount, detail)
        values (p_user_id, 'borrow', v_borrowed, jsonb_build_object('symbol', v_symbol, 'quantity', p_quantity, 'price', p_price));
    end if;

    if v_qty is null then
      v_new_qty := p_quantity;
      v_new_avg := p_price;
      insert into public.holdings (user_id, symbol, quantity, avg_cost, updated_at)
        values (p_user_id, v_symbol, v_new_qty, v_new_avg, now());
    else
      v_new_qty := v_qty + p_quantity;
      v_new_avg := ((v_qty * v_avg) + (p_quantity * p_price)) / v_new_qty;
      update public.holdings
        set quantity = v_new_qty, avg_cost = v_new_avg, updated_at = now()
        where user_id = p_user_id and symbol = v_symbol;
    end if;

  else -- sell
    if v_qty is null or p_quantity > v_qty then
      raise exception 'insufficient_shares';
    end if;

    v_total := p_price * p_quantity;
    -- Proceeds pay down any outstanding margin loan FIRST, then land in
    -- cash. A no-op split when margin_loan = 0 — see the header note above.
    v_loan_repaid := least(v_total, v_margin_loan);
    v_cash_credit := v_total - v_loan_repaid;

    update public.profiles
      set cash_balance = cash_balance + v_cash_credit,
          margin_loan  = margin_loan - v_loan_repaid,
          -- A $0 loan can NEVER be under the maintenance requirement (equity
          -- = cash + positions_value ≥ positions_value ≥ maintenance_req
          -- whenever cash ≥ 0, which it always is) — so a full paydown to
          -- exactly 0, however it happens, must clear any stale
          -- warning/call status immediately rather than waiting for the
          -- next monitor run to notice.
          margin_status = case when margin_loan - v_loan_repaid <= 0 then 'ok' else margin_status end
      where id = p_user_id
      returning cash_balance, margin_loan into v_cash, v_margin_loan;

    if v_loan_repaid > 0 then
      insert into public.margin_events (user_id, kind, amount, detail)
        values (p_user_id, 'repay', v_loan_repaid, jsonb_build_object('symbol', v_symbol, 'quantity', p_quantity, 'price', p_price, 'auto', true));
    end if;

    v_new_qty := v_qty - p_quantity;
    if v_new_qty = 0 then
      delete from public.holdings where user_id = p_user_id and symbol = v_symbol;
      v_new_avg := null;
    else
      v_new_avg := v_avg;
      update public.holdings
        set quantity = v_new_qty, updated_at = now()
        where user_id = p_user_id and symbol = v_symbol;
    end if;
  end if;

  insert into public.transactions (user_id, symbol, side, quantity, price, total, order_type, status)
    values (p_user_id, v_symbol, p_side, p_quantity, p_price, v_total, 'market', 'filled');

  return jsonb_build_object(
    'cash_balance',      v_cash,
    'margin_loan',       v_margin_loan,
    'symbol',            v_symbol,
    'side',              p_side,
    'quantity',          p_quantity,
    'price',             p_price,
    'total',             v_total,
    'position_quantity', coalesce(v_new_qty, 0),
    'position_avg_cost', v_new_avg
  );
end;
$$;

revoke all on function public.execute_trade(uuid, text, text, numeric, numeric, numeric) from public;
revoke all on function public.execute_trade(uuid, text, text, numeric, numeric, numeric) from anon;
revoke all on function public.execute_trade(uuid, text, text, numeric, numeric, numeric) from authenticated;
grant execute on function public.execute_trade(uuid, text, text, numeric, numeric, numeric) to service_role;

-- ══════════════════════════════════════════════════════════════
-- execute_option_trade — updated for margin (0010 → this). Same drop-then-
-- create treatment (new final parameter = new signature) and the same
-- margin-off-is-a-no-op guarantee as execute_trade above.
-- ══════════════════════════════════════════════════════════════
drop function if exists public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric);

create or replace function public.execute_option_trade(
  p_user_id          uuid,
  p_contract_id      text,
  p_symbol           text,
  p_opt_type         text,
  p_strike           numeric,
  p_expiry           date,
  p_side             text,
  p_contracts        numeric,
  p_premium          numeric,
  p_positions_value  numeric default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol         text := upper(trim(p_symbol));
  v_contract_id    text := upper(trim(p_contract_id));
  v_cash           numeric;
  v_margin_loan    numeric;
  v_margin_enabled boolean;
  v_buying_power   numeric;
  v_cash_used      numeric;
  v_borrowed       numeric;
  v_loan_repaid    numeric;
  v_cash_credit    numeric;
  v_contracts      numeric;
  v_avg            numeric;
  v_new_contracts  numeric;
  v_new_avg        numeric;
  v_total          numeric;
begin
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

  select cash_balance, margin_loan, margin_enabled
    into v_cash, v_margin_loan, v_margin_enabled
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  select contracts, avg_premium into v_contracts, v_avg
  from public.option_positions
  where user_id = p_user_id and contract_id = v_contract_id
  for update;

  if p_side = 'buy_to_open' then
    v_total := p_premium * 100 * p_contracts;
    v_buying_power := public.margin_buying_power(v_cash, v_margin_loan, v_margin_enabled, coalesce(p_positions_value, 0));
    if v_total > v_buying_power then
      raise exception 'insufficient_funds';
    end if;

    v_cash_used := least(v_total, v_cash);
    v_borrowed := greatest(0, v_total - v_cash);

    update public.profiles
      set cash_balance = cash_balance - v_cash_used,
          margin_loan  = margin_loan + v_borrowed
      where id = p_user_id
      returning cash_balance, margin_loan into v_cash, v_margin_loan;

    if v_borrowed > 0 then
      insert into public.margin_events (user_id, kind, amount, detail)
        values (p_user_id, 'borrow', v_borrowed, jsonb_build_object('contract_id', v_contract_id, 'contracts', p_contracts, 'premium', p_premium));
    end if;

    if v_contracts is null then
      v_new_contracts := p_contracts;
      v_new_avg := p_premium;
      insert into public.option_positions
        (user_id, contract_id, symbol, opt_type, strike, expiry, contracts, avg_premium, opened_at, updated_at)
        values (p_user_id, v_contract_id, v_symbol, p_opt_type, p_strike, p_expiry, v_new_contracts, v_new_avg, now(), now());
    else
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
    v_loan_repaid := least(v_total, v_margin_loan);
    v_cash_credit := v_total - v_loan_repaid;

    update public.profiles
      set cash_balance = cash_balance + v_cash_credit,
          margin_loan  = margin_loan - v_loan_repaid,
          margin_status = case when margin_loan - v_loan_repaid <= 0 then 'ok' else margin_status end
      where id = p_user_id
      returning cash_balance, margin_loan into v_cash, v_margin_loan;

    if v_loan_repaid > 0 then
      insert into public.margin_events (user_id, kind, amount, detail)
        values (p_user_id, 'repay', v_loan_repaid, jsonb_build_object('contract_id', v_contract_id, 'contracts', p_contracts, 'premium', p_premium, 'auto', true));
    end if;

    v_new_contracts := v_contracts - p_contracts;
    if v_new_contracts = 0 then
      delete from public.option_positions where user_id = p_user_id and contract_id = v_contract_id;
      v_new_avg := null;
    else
      v_new_avg := v_avg;
      update public.option_positions
        set contracts = v_new_contracts, updated_at = now()
        where user_id = p_user_id and contract_id = v_contract_id;
    end if;
  end if;

  insert into public.option_transactions (user_id, contract_id, symbol, side, contracts, premium, total)
    values (p_user_id, v_contract_id, v_symbol, p_side, p_contracts, p_premium, v_total);

  return jsonb_build_object(
    'cash_balance',         v_cash,
    'margin_loan',          v_margin_loan,
    'contract_id',          v_contract_id,
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

revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) from public;
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) from anon;
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) from authenticated;
grant execute on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) to service_role;

-- ══════════════════════════════════════════════════════════════
-- settle_expired_option — updated for margin (0011 → this). SAME signature
-- (settlement doesn't need buying-power inputs, only a crediting-order
-- change), so CREATE OR REPLACE in place, no drop needed — the "sells/
-- settlements pay down the loan first" rule applies here too.
-- ══════════════════════════════════════════════════════════════
create or replace function public.settle_expired_option(
  p_user_id           uuid,
  p_contract_id       text,
  p_settle_per_share  numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id text := upper(trim(p_contract_id));
  v_cash        numeric;
  v_margin_loan numeric;
  v_loan_repaid numeric;
  v_cash_credit numeric;
  v_contracts   numeric;
  v_symbol      text;
  v_expiry      date;
  v_total       numeric;
  v_side        text;
begin
  if p_settle_per_share is null or p_settle_per_share < 0 then
    raise exception 'invalid_settle_amount';
  end if;

  select cash_balance, margin_loan into v_cash, v_margin_loan
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  select contracts, symbol, expiry into v_contracts, v_symbol, v_expiry
  from public.option_positions
  where user_id = p_user_id and contract_id = v_contract_id
  for update;

  if not found then
    raise exception 'position_not_found';
  end if;

  if v_expiry >= current_date then
    raise exception 'not_expired';
  end if;

  v_total := p_settle_per_share * 100 * v_contracts;
  v_side := case when p_settle_per_share > 0 then 'settled' else 'expired' end;

  v_loan_repaid := least(v_total, v_margin_loan);
  v_cash_credit := v_total - v_loan_repaid;

  update public.profiles
    set cash_balance = cash_balance + v_cash_credit,
        margin_loan  = margin_loan - v_loan_repaid,
        margin_status = case when margin_loan - v_loan_repaid <= 0 then 'ok' else margin_status end
    where id = p_user_id
    returning cash_balance, margin_loan into v_cash, v_margin_loan;

  if v_loan_repaid > 0 then
    insert into public.margin_events (user_id, kind, amount, detail)
      values (p_user_id, 'repay', v_loan_repaid, jsonb_build_object('contract_id', v_contract_id, 'auto', true, 'source', 'settlement'));
  end if;

  delete from public.option_positions where user_id = p_user_id and contract_id = v_contract_id;

  insert into public.option_transactions (user_id, contract_id, symbol, side, contracts, premium, total)
    values (p_user_id, v_contract_id, v_symbol, v_side, v_contracts, p_settle_per_share, v_total);

  return jsonb_build_object(
    'cash_balance', v_cash,
    'margin_loan',  v_margin_loan,
    'contract_id',  v_contract_id,
    'symbol',       v_symbol,
    'side',         v_side,
    'contracts',    v_contracts,
    'settle_per_share', p_settle_per_share,
    'total',        v_total
  );
end;
$$;

revoke all on function public.settle_expired_option(uuid, text, numeric) from public;
revoke all on function public.settle_expired_option(uuid, text, numeric) from anon;
revoke all on function public.settle_expired_option(uuid, text, numeric) from authenticated;
grant execute on function public.settle_expired_option(uuid, text, numeric) to service_role;
