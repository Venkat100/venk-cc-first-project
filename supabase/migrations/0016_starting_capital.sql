-- 0016_starting_capital.sql
-- Product-phase kickoff, PLAN.md §C: starting capital for NEW accounts drops
-- from $100,000 to $25,000, on educational grounds (forces real position-
-- sizing discipline) — not monetization. Existing accounts KEEP their
-- balance; this migration never touches anyone's cash_balance.
--
-- THE ENUMERATE-EVERY-DERIVED-FIGURE PROBLEM (the equity-bug lesson, PLAN.md
-- §5): Dashboard's "Total return $/%" is computed as
-- `total_value - starting_capital`. That was a single hardcoded module
-- constant (100000) everywhere it appeared. If we just changed the constant
-- to 25000, every EXISTING $100k account's total-return math would silently
-- go wrong — comparing their real $100,000 starting point against a $25,000
-- baseline that was never true for them. A single global constant cannot
-- correctly describe two different cohorts (pre- and post-this-migration
-- signups) with two different true starting points.
--
-- FIX: `profiles` gets its own `starting_capital` column, recording each
-- account's ACTUAL historical starting point — not a shared assumption.
--   • Existing rows backfilled to 100000 (their true, factual history —
--     this is NOT "migrating" anyone's capital, it's recording what already
--     happened, same historical-fact spirit as 0004's one-time $100k chart-
--     origin seed for pre-existing users).
--   • Column default going forward is 25000, matched explicitly (not
--     relied upon implicitly) by handle_new_user() below.
--   • reset_paper_account() sets starting_capital = 25000 too — per
--     PLAN.md §C: "Reset now returns to the current default" — a RESET
--     account explicitly moves an old $100k user onto today's $25k regime,
--     while an account that never resets keeps its original $100,000.
--     Deliberate, not an oversight: the only account state that can ever
--     change an EXISTING user's true starting capital is their own
--     voluntary reset.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE
-- FUNCTION throughout).

-- ──────────────────────────────────────────────────────────────
-- 1) profiles.starting_capital — nullable first so the backfill can tell
--    "existing row, needs 100000" apart from "brand new insert, needs
--    25000" before locking in NOT NULL + the new default.
-- ──────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists starting_capital numeric;

update public.profiles set starting_capital = 100000 where starting_capital is null;

alter table public.profiles alter column starting_capital set not null;
alter table public.profiles alter column starting_capital set default 25000;

comment on column public.profiles.starting_capital is
  'The virtual cash this account actually started with (or was last reset to) — 100000 for every pre-2026-08-09 account (their real history), 25000 for every account created or reset since. Dashboard total-return math reads THIS per-user value, never a hardcoded constant.';

-- ──────────────────────────────────────────────────────────────
-- 2) handle_new_user — new signups get $25,000, matching starting_capital.
-- ──────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, cash_balance, starting_capital)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    25000,
    25000
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ──────────────────────────────────────────────────────────────
-- 3) reset_paper_account — resets to the CURRENT default (25000), both
--    cash_balance and starting_capital, plus the chart-origin snapshot.
--    Everything else in this function is UNCHANGED from 0015 — only the
--    hardcoded 100000 literals become 25000 (5 sites: the profiles update,
--    the portfolio_snapshots origin insert ×2, and the returned jsonb).
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
    set cash_balance = 25000,
        starting_capital = 25000,
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
    values (p_user_id, 25000, 25000, 0, current_date);

  insert into public.account_events (user_id, kind, detail)
    values (p_user_id, 'reset', jsonb_build_object(
      'holdings_cleared', v_holdings_count,
      'option_positions_cleared', v_option_count,
      'agent_holdings_cleared', v_agent_holdings_count,
      'pending_proposals_cleared', v_proposals_count,
      'margin_loan_forgiven', v_margin_loan_forgiven
    ));

  return jsonb_build_object(
    'cash_balance', 25000,
    'holdings_cleared', v_holdings_count,
    'option_positions_cleared', v_option_count,
    'agent_holdings_cleared', v_agent_holdings_count,
    'pending_proposals_cleared', v_proposals_count,
    'margin_loan_forgiven', v_margin_loan_forgiven
  );
end;
$$;
-- Grants on reset_paper_account are unchanged from 0015 (service_role-only
-- EXECUTE) — CREATE OR REPLACE keeps the existing grants, no re-grant needed.
