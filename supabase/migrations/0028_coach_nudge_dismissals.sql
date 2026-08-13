-- 0028_coach_nudge_dismissals.sql
-- AUDIT.md Part 6(c) item 10 (2026-08-14 Tier-2 fix pass) — persistence for
-- the proactive Coach nudge card (Dashboard/Portfolio). The nudge fires only
-- when lib/coaching/priority.ts's pickTopLesson() returns a triggered
-- pattern — the EXACT same gate the Coach page's own "Right now, this is
-- worth your attention" card uses, never a separate trade-count rule.
--
-- "Don't re-nag until there's a genuinely NEW observation" — defined here as
-- the underlying MetricResult's own sample size `n` changing. Each pattern
-- already self-reports `n` (lib/behavioral/metrics.ts's MetricResult), so
-- dismissing at n=8 stays dismissed while n=8 (nothing new happened since);
-- once more closed trades push that pattern's n to, say, 12, the dismissal
-- no longer matches and the nudge is eligible to show again — but ONLY if
-- still triggered. This reuses a field the app already computes rather than
-- inventing a new fingerprint.
--
-- No money/price involved and nothing here is journal content — same
-- client-writable, owner-only-RLS shape as watchlist (0002) and
-- journal_entries (0023), not a server-function-gated table.
create table if not exists public.coach_nudge_dismissals (
  user_id      uuid not null references auth.users (id) on delete cascade,
  lesson_key   text not null,
  n            integer not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, lesson_key)
);

create index if not exists coach_nudge_dismissals_user_id_idx on public.coach_nudge_dismissals (user_id);

alter table public.coach_nudge_dismissals enable row level security;

drop policy if exists "coach_nudge_dismissals_select_own" on public.coach_nudge_dismissals;
create policy "coach_nudge_dismissals_select_own" on public.coach_nudge_dismissals
  for select using (auth.uid() = user_id);

drop policy if exists "coach_nudge_dismissals_insert_own" on public.coach_nudge_dismissals;
create policy "coach_nudge_dismissals_insert_own" on public.coach_nudge_dismissals
  for insert with check (auth.uid() = user_id);

-- UPDATE (not just insert) so re-dismissing the SAME lesson_key at a new n
-- is a single upsert on the (user_id, lesson_key) primary key, not a
-- delete+insert.
drop policy if exists "coach_nudge_dismissals_update_own" on public.coach_nudge_dismissals;
create policy "coach_nudge_dismissals_update_own" on public.coach_nudge_dismissals
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.coach_nudge_dismissals to authenticated;

-- service_role gets the same grants as every other user table with a
-- reset/delete story (see reset_paper_account's SECURITY DEFINER scope and
-- the delete-account cascade), for cron/admin housekeeping — not written to
-- from any current code path, but withholding it would be the odd one out
-- among every other non-journal user table in this schema.
grant select, insert, update, delete on public.coach_nudge_dismissals to service_role;
