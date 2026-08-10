-- Per-user abuse & cost guards (PLAN.md §6 step 5, part A2). Last gate
-- before open public signup: today ANY signed-up user can click "Run agent
-- now" or request an AI insight in a tight loop and burn real Anthropic
-- budget with zero server-side limit — the UI has no throttle and neither
-- does the server function underneath it.
--
-- THREAT MODEL, and why each guarded path is guarded (see HANDOFF for the
-- full numeric reasoning):
--   • Per-stock insights (getStockInsightFn) are cached ONE Claude call per
--     SYMBOL per DAY, globally, shared across every user (insights.server.ts,
--     the `insights` table) — so repeat-viewing the SAME symbol is already
--     free after the first hit of the day. The real cost vector is a burst
--     across MANY DISTINCT symbols in a short window, each a genuine cache
--     miss. The rate limit is therefore only checked on an actual cache
--     miss (wired in lib/insights/insights.server.ts), not on every view.
--   • "Run agent now" (runAgentThinkerFn -> runThinker) has NO cache at
--     all — every real click does a fresh quant scan across the trading
--     universe (a burst of provider quote requests) PLUS one real Claude
--     call when AI is enabled. Guarded on every invocation, not just AI
--     hits, since the quant burst alone is worth guarding.
--   • The daily brief (runDailyBriefs) and the daily cron's own agent-thinker
--     run are NOT user-triggerable — they're cron-only (no client-callable
--     server function calls them), so they are trusted infra and
--     deliberately NOT rate-limited here; doing so would risk a cron
--     silently failing itself.
--   • The watchdog (runAgentWatchdogFn) makes NO Claude calls and only
--     re-prices the CALLER's OWN already-bounded holdings through the
--     existing durable price_cache (step 2) — not a meaningful abuse
--     surface, deliberately left unguarded rather than adding a limit that
--     protects against nothing.
--
-- DESIGN: an append-only event log (one row per ALLOWED invocation, not per
-- request) rather than a fixed-window counter table, because a burst limit
-- specifically wants a TRUE rolling window ("no more than N in the last 60
-- real seconds", not "no more than N since the top of the current clock
-- minute" — a fixed-window counter lets a user burst 2x at a window
-- boundary). Counting rows with created_at >= now() - interval gives an
-- honest rolling window for the burst check, and the SAME table/query
-- (created_at >= start-of-UTC-day) gives the daily cap for free — one
-- table serves both checks. Same "small event-log table, prunable" shape
-- as every other cache/audit table this project has added (price_cache,
-- account_events).
create table if not exists public.rate_limit_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now()
);

-- Serves both the burst check (user_id, action, created_at >= recent) and
-- the daily-prune sweep (created_at alone, via the second index).
create index if not exists rate_limit_events_user_action_created_idx
  on public.rate_limit_events (user_id, action, created_at desc);
create index if not exists rate_limit_events_created_at_idx
  on public.rate_limit_events (created_at);

alter table public.rate_limit_events enable row level security;
-- No policies created: RLS-with-zero-policies denies ALL access to every
-- role except the owner/BYPASSRLS, same enforced-deny pattern as
-- price_cache and insights — service_role only, in both directions. A
-- user must never be able to read (reveals how close they are to a limit
-- in a way that helps them game it) or, far worse, DELETE their own
-- counter rows to reset their limit.
revoke all on public.rate_limit_events from public;
revoke all on public.rate_limit_events from anon;
revoke all on public.rate_limit_events from authenticated;
grant select, insert, delete on public.rate_limit_events to service_role;

-- ──────────────────────────────────────────────────────────────
-- check_and_record_rate_limit — atomic check-then-insert. A naive
-- "SELECT count(*) in JS, then INSERT if under the limit" has a genuine
-- TOCTOU race: two near-simultaneous requests from the same user can both
-- read a count that's still under the limit before either has inserted,
-- and both proceed — exactly the kind of double-spend every OTHER atomic
-- operation in this schema (execute_trade, fund_agent, reset_paper_account)
-- is written in plpgsql specifically to avoid. This table has no single
-- natural row to lock (unlike `profiles`, which every money function locks
-- FOR UPDATE), so the equivalent here is a transaction-scoped ADVISORY
-- LOCK keyed on (user_id, action) — serializes concurrent calls for the
-- SAME user+action pair (harmless: legitimate concurrent requests just
-- queue briefly) without taking any lock at all for different users or
-- different actions. Released automatically at the end of this function's
-- implicit transaction.
create or replace function public.check_and_record_rate_limit(
  p_user_id uuid,
  p_action text,
  p_burst_limit int,
  p_burst_window_seconds int,
  p_daily_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_burst_count int;
  v_daily_count int;
  v_day_start   timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_action, 0));

  select count(*) into v_burst_count
    from public.rate_limit_events
    where user_id = p_user_id and action = p_action
      and created_at >= now() - make_interval(secs => p_burst_window_seconds);

  if v_burst_count >= p_burst_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'burst',
      'retry_after_seconds', p_burst_window_seconds
    );
  end if;

  select count(*) into v_daily_count
    from public.rate_limit_events
    where user_id = p_user_id and action = p_action
      and created_at >= v_day_start;

  if v_daily_count >= p_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily',
      'resets_at', v_day_start + interval '1 day'
    );
  end if;

  insert into public.rate_limit_events (user_id, action) values (p_user_id, p_action);

  return jsonb_build_object(
    'allowed', true,
    'burst_count', v_burst_count + 1,
    'daily_count', v_daily_count + 1
  );
end;
$$;

revoke all on function public.check_and_record_rate_limit(uuid, text, int, int, int) from public;
revoke all on function public.check_and_record_rate_limit(uuid, text, int, int, int) from anon;
revoke all on function public.check_and_record_rate_limit(uuid, text, int, int, int) from authenticated;
grant execute on function public.check_and_record_rate_limit(uuid, text, int, int, int) to service_role;
