-- 0006_agent_execute.sql
-- PaperTrader — Phase 10.2 (AI agent decision engine).
-- Atomic buy/sell INTO the agent sub-portfolio (mirrors execute_trade, but on
-- agent_config.agent_cash + agent_holdings + agent_transactions). Price is
-- supplied by the server (fetched server-side), never the client.
--
-- EXECUTE granted only to service_role — reached through the server-side
-- agent thinker. Idempotent.

create or replace function public.agent_execute_trade(
  p_user_id  uuid,
  p_symbol   text,
  p_side     text,
  p_quantity numeric,
  p_price    numeric,
  p_reason   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol  text := upper(trim(p_symbol));
  v_cash    numeric;
  v_qty     numeric;
  v_avg     numeric;
  v_new_qty numeric;
  v_new_avg numeric;
  v_total   numeric;
begin
  if p_side not in ('buy', 'sell') then raise exception 'invalid_side'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'invalid_quantity'; end if;
  if p_price is null or p_price <= 0 then raise exception 'invalid_price'; end if;

  -- Lock the agent's cash row.
  select agent_cash into v_cash from public.agent_config where user_id = p_user_id for update;
  if not found then raise exception 'agent_not_funded'; end if;

  select quantity, avg_cost into v_qty, v_avg
  from public.agent_holdings where user_id = p_user_id and symbol = v_symbol for update;

  if p_side = 'buy' then
    v_total := p_price * p_quantity;
    if v_total > v_cash then raise exception 'insufficient_agent_cash'; end if;
    update public.agent_config set agent_cash = agent_cash - v_total, updated_at = now()
      where user_id = p_user_id returning agent_cash into v_cash;
    if v_qty is null then
      v_new_qty := p_quantity; v_new_avg := p_price;
      insert into public.agent_holdings (user_id, symbol, quantity, avg_cost, updated_at)
        values (p_user_id, v_symbol, v_new_qty, v_new_avg, now());
    else
      v_new_qty := v_qty + p_quantity;
      v_new_avg := ((v_qty * v_avg) + (p_quantity * p_price)) / v_new_qty;
      update public.agent_holdings set quantity = v_new_qty, avg_cost = v_new_avg, updated_at = now()
        where user_id = p_user_id and symbol = v_symbol;
    end if;
  else -- sell
    if v_qty is null or p_quantity > v_qty then raise exception 'insufficient_shares'; end if;
    v_total := p_price * p_quantity;
    update public.agent_config set agent_cash = agent_cash + v_total, updated_at = now()
      where user_id = p_user_id returning agent_cash into v_cash;
    v_new_qty := v_qty - p_quantity;
    if v_new_qty = 0 then
      delete from public.agent_holdings where user_id = p_user_id and symbol = v_symbol;
      v_new_avg := null;
    else
      v_new_avg := v_avg;
      update public.agent_holdings set quantity = v_new_qty, updated_at = now()
        where user_id = p_user_id and symbol = v_symbol;
    end if;
  end if;

  insert into public.agent_transactions (user_id, symbol, side, quantity, price, total, reason)
    values (p_user_id, v_symbol, p_side, p_quantity, p_price, v_total, p_reason);

  return jsonb_build_object(
    'agent_cash', v_cash,
    'symbol', v_symbol,
    'side', p_side,
    'quantity', p_quantity,
    'price', p_price,
    'total', v_total,
    'position_quantity', coalesce(v_new_qty, 0),
    'position_avg_cost', v_new_avg
  );
end;
$$;

revoke all on function public.agent_execute_trade(uuid, text, text, numeric, numeric, text) from public;
revoke all on function public.agent_execute_trade(uuid, text, text, numeric, numeric, text) from anon;
revoke all on function public.agent_execute_trade(uuid, text, text, numeric, numeric, text) from authenticated;
grant execute on function public.agent_execute_trade(uuid, text, text, numeric, numeric, text) to service_role;
