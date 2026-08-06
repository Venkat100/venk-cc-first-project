-- 0015_reset_account.sql
-- C1b — makes "Reset paper account" (Settings) a REAL action. Found during
-- C1: the button was a pure UI stub (toast only, never wired to anything) —
-- a leftover from the original Lovable design, live for months. C1's new
-- destructive confirmation made this actively misleading (confirm → a
-- "success" toast → nothing had actually happened). This migration is the
-- real fix.
--
-- DESIGN: reset returns the account to the SAME state as a brand-new
-- signup — a full financial clean slate — but does NOT touch identity/login
-- (auth.users is never touched) or the watchlist (a preference, not a
-- position — explicitly kept, per instruction).
--
-- SCOPE OF THE WIPE, decided and documented here (each a deliberate call,
-- not an oversight):
--
--   • holdings, option_positions, agent_holdings, PENDING agent_proposals:
--     DELETED outright — a brand-new account has none of these.
--
--   • profiles: cash_balance -> 100000; margin state back to column
--     defaults (margin_enabled=false, margin_loan=0, margin_status='ok',
--     last_interest_accrued_at=null). `id`/`display_name`/`created_at` are
--     untouched — reset is not re-signup.
--
--   • agent_config: reset to its own column defaults (enabled=false,
--     mode='autonomous', risk_level='balanced', agent_cash=0,
--     allocated_total=0) rather than deleted — profiles isn't deleted
--     either, and a fresh account's agent_config would read identically to
--     this the first time it's touched.
--
--   • OUTSTANDING MARGIN LOAN: reset is ALLOWED even when margin_loan > 0.
--     A full wipe forgives it along with everything else — the loan was
--     virtual money borrowed against virtual positions that no longer
--     exist after this call, so there is nothing left to collect against.
--     This is the ONLY place in this schema a margin_loan can reach zero
--     WITHOUT a 'repay' event, because nothing was actually repaid — it's
--     erased, not paid down. Deliberate, not a bug: documented here AND in
--     the confirmation dialog's copy so it is never a silent surprise.
--
--   • portfolio_snapshots / agent_snapshots: DELETED for the user, then
--     ONE fresh row is inserted into portfolio_snapshots dated TODAY at
--     $100,000 (cash=100000, holdings_value=0) — the value chart's new
--     origin point. Deleting alone would leave the chart either showing a
--     stale multi-week history that no longer corresponds to any real
--     position, or (until tomorrow's cron) simply blank; a fresh
--     today-dated origin is exactly what a brand-new account's chart looks
--     like on day one. agent_snapshots gets no replacement row — the daily
--     writer itself never snapshots an unfunded agent (agent_cash=0 now),
--     so a synthetic row here would immediately be inconsistent with that
--     rule.
--
--   • APPEND-ONLY LEDGERS — transactions, option_transactions,
--     agent_decisions, margin_events: KEPT, not deleted. Every one of
--     these tables is documented elsewhere in this schema as append-only
--     (no DELETE grant for authenticated, service_role-only INSERT) — even
--     a full position close (sell-to-close, expiry settlement) never
--     deletes ITS OWN transaction log, only the position row. Reset is the
--     same kind of "position closes, ledger remains" operation, just
--     applied to everything at once at the account level; deleting the
--     ledgers here would make this the one place in the entire schema that
--     breaks that invariant. Instead, one marker row is appended to the
--     new `account_events` table below, so the account's history reads
--     honestly: old trades remain real trade history, just from before the
--     account was reset. The Settings UI copy is written to match this
--     exactly — it does NOT claim trade history is erased.
--
-- Idempotent: safe to re-run (CREATE TABLE IF NOT EXISTS / CREATE OR
-- REPLACE FUNCTION throughout).

-- ──────────────────────────────────────────────────────────────
-- account_events — append-only audit of account-level lifecycle events.
-- A new, minimal table rather than overloading `margin_events` (documented
-- as margin-specific) or `agent_decisions` (the AGENT's own decision log,
-- and not every user who resets has ever touched the agent) — this is
-- neither, and deserves its own narrow home. Same "owner-only RLS select,
-- service_role-only writes" pattern as every other audit table here.
-- ──────────────────────────────────────────────────────────────
create table if not exists public.account_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('reset')),
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index if not exists account_events_user_created_idx
  on public.account_events (user_id, created_at desc);

alter table public.account_events enable row level security;

drop policy if exists "account_events_select_own" on public.account_events;
create policy "account_events_select_own" on public.account_events
  for select using (auth.uid() = user_id);

-- Deliberately no insert/update/delete policy for authenticated: every row
-- is written EXCLUSIVELY by reset_paper_account below, via service_role.
grant select on public.account_events to authenticated;
grant select, insert on public.account_events to service_role;

-- ──────────────────────────────────────────────────────────────
-- reset_paper_account — the atomic wipe. Locks the profiles row FOR UPDATE
-- (same discipline as every money-moving function in this schema) so a
-- reset can never race a concurrent trade/margin/agent call on the same
-- account.
-- ──────────────────────────────────────────────────────────────
create or replace function public.reset_paper_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_margin_loan_forgiven numeric;
  v_holdings_count       integer;
  v_option_count         integer;
  v_agent_holdings_count integer;
  v_proposals_count      integer;
begin
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'profile_not_found';
  end if;

  select coalesce(margin_loan, 0) into v_margin_loan_forgiven
  from public.profiles where id = p_user_id;

  select count(*) into v_holdings_count from public.holdings where user_id = p_user_id;
  select count(*) into v_option_count from public.option_positions where user_id = p_user_id;
  select count(*) into v_agent_holdings_count from public.agent_holdings where user_id = p_user_id;
  select count(*) into v_proposals_count from public.agent_proposals where user_id = p_user_id and status = 'pending';

  delete from public.holdings where user_id = p_user_id;
  delete from public.option_positions where user_id = p_user_id;
  delete from public.agent_holdings where user_id = p_user_id;
  delete from public.agent_proposals where user_id = p_user_id and status = 'pending';

  update public.profiles
    set cash_balance = 100000,
        margin_enabled = false,
        margin_loan = 0,
        margin_status = 'ok',
        last_interest_accrued_at = null
    where id = p_user_id;

  update public.agent_config
    set enabled = false,
        mode = 'autonomous',
        risk_level = 'balanced',
        agent_cash = 0,
        allocated_total = 0,
        updated_at = now()
    where user_id = p_user_id;

  delete from public.portfolio_snapshots where user_id = p_user_id;
  delete from public.agent_snapshots where user_id = p_user_id;

  insert into public.portfolio_snapshots (user_id, total_value, cash, holdings_value, captured_at)
    values (p_user_id, 100000, 100000, 0, current_date);

  insert into public.account_events (user_id, kind, detail)
    values (p_user_id, 'reset', jsonb_build_object(
      'holdings_cleared', v_holdings_count,
      'option_positions_cleared', v_option_count,
      'agent_holdings_cleared', v_agent_holdings_count,
      'pending_proposals_cleared', v_proposals_count,
      'margin_loan_forgiven', v_margin_loan_forgiven
    ));

  return jsonb_build_object(
    'cash_balance', 100000,
    'holdings_cleared', v_holdings_count,
    'option_positions_cleared', v_option_count,
    'agent_holdings_cleared', v_agent_holdings_count,
    'pending_proposals_cleared', v_proposals_count,
    'margin_loan_forgiven', v_margin_loan_forgiven
  );
end;
$$;

revoke all on function public.reset_paper_account(uuid) from public;
revoke all on function public.reset_paper_account(uuid) from anon;
revoke all on function public.reset_paper_account(uuid) from authenticated;
grant execute on function public.reset_paper_account(uuid) to service_role;
