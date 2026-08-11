-- 0023_journal.sql
-- PLAN.md §6 step 6 (B1) — trade journal / notes.
--
-- DATA MODEL: one journal_entries table serves both standalone dated
-- entries and trade-linked notes (at most one of transaction_id /
-- option_transaction_id set — never both, enforced below). A note attaches
-- to the TRANSACTION, not the holding/option_position: holdings and
-- option_positions are ephemeral (the row is DELETED the moment a position
-- fully closes — see execute_trade/execute_option_trade), but transactions
-- and option_transactions are the permanent, immutable ledger. So a note
-- written on a buy stays attached forever, even after that position is
-- later sold to zero and its holding row is gone — exactly the property
-- the journal needs ("what did I think when I bought this, and what
-- actually happened since"). `symbol` is denormalized onto every row
-- (copied from the linked transaction at write time, or set directly by
-- the user for a standalone entry) so trade-linked and free-form entries
-- can both be filtered by symbol from one column, with no join.
--
-- Also extends execute_trade / execute_option_trade (same signatures, just
-- returning one more field each) so the client can link a note to the
-- EXACT transaction a trade just created, for the optional non-blocking
-- "why this trade?" capture at trade time.
--
-- Safe to run more than once (idempotent guards throughout, matching the
-- rest of this migration set).

-- ──────────────────────────────────────────────────────────────
-- journal_entries
-- ──────────────────────────────────────────────────────────────
create table if not exists public.journal_entries (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  transaction_id         uuid references public.transactions (id) on delete cascade,
  option_transaction_id  uuid references public.option_transactions (id) on delete cascade,
  symbol                 text,
  title                  text,
  body                   text not null,
  entry_date             date not null default current_date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint journal_entries_body_not_blank check (btrim(body) <> ''),
  constraint journal_entries_at_most_one_link check (
    (case when transaction_id is not null then 1 else 0 end) +
    (case when option_transaction_id is not null then 1 else 0 end) <= 1
  )
);

create index if not exists journal_entries_user_date_idx on public.journal_entries (user_id, entry_date desc, created_at desc);
create index if not exists journal_entries_user_symbol_idx on public.journal_entries (user_id, symbol) where symbol is not null;
create index if not exists journal_entries_transaction_idx on public.journal_entries (transaction_id) where transaction_id is not null;
create index if not exists journal_entries_option_transaction_idx on public.journal_entries (option_transaction_id) where option_transaction_id is not null;

alter table public.journal_entries enable row level security;

drop policy if exists "journal_entries_select_own" on public.journal_entries;
create policy "journal_entries_select_own" on public.journal_entries
  for select using (auth.uid() = user_id);

drop policy if exists "journal_entries_insert_own" on public.journal_entries;
create policy "journal_entries_insert_own" on public.journal_entries
  for insert with check (auth.uid() = user_id);

drop policy if exists "journal_entries_update_own" on public.journal_entries;
create policy "journal_entries_update_own" on public.journal_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "journal_entries_delete_own" on public.journal_entries;
create policy "journal_entries_delete_own" on public.journal_entries
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.journal_entries to authenticated;

-- DELIBERATELY no `grant ... to service_role` here — do not add one.
--
-- Every other grant-gap fixed in this schema (0017: transactions/insights;
-- 0021: analytics_events) existed because a real SERVER-SIDE job needed the
-- table — prunes, batch processors, snapshot writers. No server-side job
-- touches journal_entries; the app reads/writes it exclusively through the
-- user's own authenticated session (lib/journal/queries.ts), the same
-- pattern already used for `watchlist`. So the absence of a service_role
-- grant here is not an oversight to "fix" — it's the intended shape.
--
-- Journal entries are the most personal data in this product (private
-- reflections — fear, mistakes, revenge trading). Withholding the
-- service_role grant means even our own server tooling and any future
-- admin console structurally CANNOT read them — a guarantee enforced by
-- Postgres, not by policy or good intentions. This is a deliberate
-- constraint on PLAN.md step 10 (super-admin console): it will NOT be able
-- to display a user's journal entries. Lifting that requires an explicit
-- product decision and a privacy-policy update, not a quiet grant here.

-- Keep updated_at honest on every edit (mirrors no existing trigger in this
-- schema, but avoids client code being trusted to set it correctly).
create or replace function public.journal_entries_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists journal_entries_touch_updated_at on public.journal_entries;
create trigger journal_entries_touch_updated_at
  before update on public.journal_entries
  for each row execute function public.journal_entries_touch_updated_at();

-- ══════════════════════════════════════════════════════════════
-- execute_trade — additive only: same signature, now also returns the new
-- transactions.id so the client can link a trade-time note to the EXACT
-- row it just created (not a fragile "most recent transaction" re-query).
-- ══════════════════════════════════════════════════════════════
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
  v_txn_id         uuid;
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
    values (p_user_id, v_symbol, p_side, p_quantity, p_price, v_total, 'market', 'filled')
    returning id into v_txn_id;

  return jsonb_build_object(
    'transaction_id',    v_txn_id,
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
-- execute_option_trade — same additive treatment: returns option_transaction_id.
-- ══════════════════════════════════════════════════════════════
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
  v_opt_txn_id     uuid;
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
    values (p_user_id, v_contract_id, v_symbol, p_side, p_contracts, p_premium, v_total)
    returning id into v_opt_txn_id;

  return jsonb_build_object(
    'option_transaction_id', v_opt_txn_id,
    'cash_balance',          v_cash,
    'margin_loan',           v_margin_loan,
    'contract_id',           v_contract_id,
    'symbol',                v_symbol,
    'side',                  p_side,
    'contracts',             p_contracts,
    'premium',               p_premium,
    'total',                 v_total,
    'position_contracts',    coalesce(v_new_contracts, 0),
    'position_avg_premium',  v_new_avg
  );
end;
$$;

revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) from public;
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) from anon;
revoke all on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) from authenticated;
grant execute on function public.execute_option_trade(uuid, text, text, text, numeric, date, text, numeric, numeric, numeric) to service_role;
