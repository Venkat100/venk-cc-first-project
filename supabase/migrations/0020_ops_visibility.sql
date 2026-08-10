-- Ops visibility (PLAN.md §6 step 5, part A3): a cron-freshness table for
-- the /api/health endpoint, and a first-party analytics event log.
--
-- ──────────────────────────────────────────────────────────────
-- cron_heartbeats — one row per named cron job, upserted every time that
-- job runs (success OR failure). The health endpoint's "did the crons
-- actually run today" check needs an honest, direct signal — inferring
-- freshness from business data (e.g. "does portfolio_snapshots have a
-- row from today") produces false negatives whenever the business
-- condition itself is legitimately empty (e.g. an agent-thinker run where
-- zero users currently have an enabled+funded agent still means the cron
-- ran and is healthy, but would look identical to "the cron never fired"
-- if inferred from agent_decisions row counts alone). A dedicated
-- heartbeat the cron writes to ITSELF, regardless of what it did or didn't
-- find to do, has no such blind spot.
-- ──────────────────────────────────────────────────────────────
create table if not exists public.cron_heartbeats (
  job_name    text primary key,
  last_run_at timestamptz not null default now(),
  last_status text not null default 'ok' check (last_status in ('ok', 'error')),
  detail      jsonb
);

alter table public.cron_heartbeats enable row level security;
-- No policies: service_role only (enforced deny for every other role),
-- same posture as price_cache/rate_limit_events — this is operational
-- state, not user data, and no client should ever read or write it
-- directly (a client could otherwise spoof a healthy heartbeat).
revoke all on public.cron_heartbeats from public;
revoke all on public.cron_heartbeats from anon;
revoke all on public.cron_heartbeats from authenticated;
grant select, insert, update on public.cron_heartbeats to service_role;

-- ──────────────────────────────────────────────────────────────
-- analytics_events — lightweight, privacy-respecting first-party product
-- analytics (signups, activation, feature usage). Deliberately first-party
-- (our own Postgres) rather than a third-party tool for this initial cut:
-- no new external account/script/cookie is needed to ship and verify this
-- today, the data never leaves infrastructure we already operate and are
-- already accountable for under our own Privacy Policy, and it's free
-- with no vendor tier limits. `track()` (app/src/lib/analytics/track.server.ts)
-- is a thin abstraction specifically so pointing this at PostHog/Plausible/
-- Umami later is a one-file change, not a rewrite.
--
-- user_id is NULLABLE with ON DELETE SET NULL — the ONE deliberate
-- divergence from every other user-scoped table in this schema (which all
-- CASCADE delete). This is intentional, not a gap in the account-deletion
-- cascade: aggregate historical counts (signups-per-day, activation rate)
-- should NOT retroactively shrink just because a user later deletes their
-- account — exactly how privacy-respecting analytics tools (Plausible,
-- GA4) keep anonymous historical counts after a user opts out/clears
-- cookies. Severing the user_id link (rather than deleting the row) is
-- the anonymization step: after deletion the row can no longer be tied
-- back to that person, which is the actual privacy property that matters,
-- not the row's mere existence.
create table if not exists public.analytics_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users (id) on delete set null,
  event      text not null,
  properties jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_event_created_idx
  on public.analytics_events (event, created_at desc);
create index if not exists analytics_events_user_created_idx
  on public.analytics_events (user_id, created_at desc);

alter table public.analytics_events enable row level security;
-- No policies: service_role only. Same reasoning as every other
-- service_role-only table — clients must never read (would leak other
-- users' behavior as a side channel) or write (would let a tampered
-- client forge fake event volume) this table directly; every event is
-- written server-side by track().
revoke all on public.analytics_events from public;
revoke all on public.analytics_events from anon;
revoke all on public.analytics_events from authenticated;
grant select, insert on public.analytics_events to service_role;

-- ──────────────────────────────────────────────────────────────
-- handle_new_user — extended (not replaced) to also log a 'signup'
-- analytics event. This is the single most reliable place to track a
-- signup: it fires exactly once per real new auth.users row, atomically,
-- with zero risk of missing the event if a client's tab closes right
-- after signing up (which a client-side tracking call could miss). This
-- function was already safely re-defined once before, in 0016, for the
-- $25k-default change — this is a pure ADDITION alongside that unchanged
-- profile-creation logic, not a behavior change to it.
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

  insert into public.analytics_events (user_id, event) values (new.id, 'signup');

  return new;
end;
$$;
