-- 0011_option_expiry.sql
-- PaperTrader — Options & Margin epic, O4 (expiration processing).
-- v1 uses CASH SETTLEMENT at expiration (standard for simulators, simpler
-- than share delivery): an ITM position settles for its intrinsic value in
-- cash; an OTM position expires worthless. No share delivery/exercise.
--
-- EXPIRY BOUNDARY (documented, must stay consistent with execute_option_trade
-- in 0010, which currently allows trading a contract ON its expiry date —
-- p_expiry < current_date is what THAT function calls "expired"): a contract
-- is considered settleable once expiry < current_date, i.e. the SAME
-- definition, so the two functions can never disagree about a contract's
-- status. A contract expiring TODAY stays fully tradeable through the whole
-- day and is settled by TOMORROW's run, once it's unambiguously in the past
-- — this sidesteps having to reason about "has today's market close happened
-- yet" inside the settlement function itself.
--
-- Idempotent: safe to re-run.

-- Widen the ledger's side check to cover expiration outcomes. Two distinct
-- values (not one 'expiration' side with total=0-vs->0) so the ledger and any
-- UI reading it can tell the two apart without inferring from the amount —
-- "Expired worthless" vs "Settled $X" are meaningfully different events.
alter table public.option_transactions drop constraint if exists option_transactions_side_check;
alter table public.option_transactions add constraint option_transactions_side_check
  check (side in ('buy_to_open', 'sell_to_close', 'expired', 'settled'));

-- ──────────────────────────────────────────────────────────────
-- settle_expired_option — atomic cash settlement of ONE expired position
-- ──────────────────────────────────────────────────────────────
--
-- SECURITY (identical model to execute_option_trade in 0010):
--   • EXECUTE granted ONLY to service_role — reached exclusively through the
--     server-side expiry processor (lib/options/expiry.server.ts), which
--     computes p_settle_per_share from a historical closing price (never
--     client-supplied, there IS no client for this path — it's cron-only).
--   • Runs in ONE transaction, locks profiles + the position row (FOR
--     UPDATE) — the same serialization discipline as every other money-
--     moving function in this schema.
--   • Reads `contracts` from the LOCKED position row itself, not from a
--     caller-supplied parameter — the row is the only source of truth for
--     how many contracts exist; nothing else could pass a stale/wrong count.
--   • REJECTS a position whose expiry is not yet in the past — this function
--     must be structurally unable to touch a live position, independent of
--     whatever the caller's own query logic filtered for.
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
  v_contracts   numeric;
  v_symbol      text;
  v_expiry      date;
  v_total       numeric;
  v_side        text;
begin
  if p_settle_per_share is null or p_settle_per_share < 0 then
    raise exception 'invalid_settle_amount';
  end if;

  -- Lock the user's profile row so this can't race a concurrent trade/settle.
  select cash_balance into v_cash
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'profile_not_found';
  end if;

  -- Lock the position row and read ITS contracts/expiry — never trust a
  -- caller-supplied count.
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

  update public.profiles
    set cash_balance = cash_balance + v_total
    where id = p_user_id
    returning cash_balance into v_cash;

  delete from public.option_positions where user_id = p_user_id and contract_id = v_contract_id;

  insert into public.option_transactions (user_id, contract_id, symbol, side, contracts, premium, total)
    values (p_user_id, v_contract_id, v_symbol, v_side, v_contracts, p_settle_per_share, v_total);

  return jsonb_build_object(
    'cash_balance', v_cash,
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
