-- 0003_execute_trade.sql
-- PaperTrader — Phase 6 (trading engine).
-- Atomic, race-safe buy/sell executed entirely inside the database.
--
-- SECURITY:
--   • EXECUTE is granted ONLY to service_role — never to anon/authenticated —
--     so a browser can never call this directly. It is reached only through
--     the server-side executeTradeFn (TanStack Start server function) using the
--     service-role key.
--   • The whole trade runs in ONE transaction (a function body is atomic) and
--     locks the user's profiles row (FOR UPDATE) to serialize concurrent trades.
--   • The price is supplied by the server (fetched server-side), never the client.
--
-- Idempotent: safe to re-run (create or replace + revoke/grant).

create or replace function public.execute_trade(
  p_user_id  uuid,
  p_symbol   text,
  p_side     text,
  p_quantity numeric,
  p_price    numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol  text := upper(trim(p_symbol));
  v_cash    numeric;
  v_qty     numeric;   -- existing holding quantity (null if none)
  v_avg     numeric;   -- existing holding avg cost
  v_new_qty numeric;
  v_new_avg numeric;
  v_total   numeric;
begin
  -- ── Validation ──────────────────────────────────────────────
  if p_side not in ('buy', 'sell') then
    raise exception 'invalid_side';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'invalid_quantity';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'invalid_price';
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
  select quantity, avg_cost into v_qty, v_avg
  from public.holdings
  where user_id = p_user_id and symbol = v_symbol
  for update;

  if p_side = 'buy' then
    v_total := p_price * p_quantity;
    if v_total > v_cash then
      raise exception 'insufficient_funds';
    end if;

    update public.profiles
      set cash_balance = cash_balance - v_total
      where id = p_user_id
      returning cash_balance into v_cash;

    if v_qty is null then
      v_new_qty := p_quantity;
      v_new_avg := p_price;
      insert into public.holdings (user_id, symbol, quantity, avg_cost, updated_at)
        values (p_user_id, v_symbol, v_new_qty, v_new_avg, now());
    else
      -- Weighted-average cost basis.
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
    update public.profiles
      set cash_balance = cash_balance + v_total
      where id = p_user_id
      returning cash_balance into v_cash;

    v_new_qty := v_qty - p_quantity;
    if v_new_qty = 0 then
      delete from public.holdings where user_id = p_user_id and symbol = v_symbol;
      v_new_avg := null;
    else
      v_new_avg := v_avg; -- avg cost is unchanged by a sell
      update public.holdings
        set quantity = v_new_qty, updated_at = now()
        where user_id = p_user_id and symbol = v_symbol;
    end if;
  end if;

  -- Append to the immutable ledger.
  insert into public.transactions (user_id, symbol, side, quantity, price, total, order_type, status)
    values (p_user_id, v_symbol, p_side, p_quantity, p_price, v_total, 'market', 'filled');

  return jsonb_build_object(
    'cash_balance',      v_cash,
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

-- Lock the function down: callable only by service_role (server-side).
revoke all on function public.execute_trade(uuid, text, text, numeric, numeric) from public;
revoke all on function public.execute_trade(uuid, text, text, numeric, numeric) from anon;
revoke all on function public.execute_trade(uuid, text, text, numeric, numeric) from authenticated;
grant execute on function public.execute_trade(uuid, text, text, numeric, numeric) to service_role;
