-- 0008_agent_proposals.sql
-- PaperTrader — Phase 10 hardening #4a (approve-first mode).
-- When an agent is in mode='approve', the thinker writes a reviewable PROPOSAL
-- instead of trading. The user approves (executes toward the target at CURRENT
-- prices) or rejects it. Autonomous mode is unaffected.
--
-- Rows are written SERVER-SIDE only (service-role, via the thinker + the
-- approve/reject server functions). Owners may SELECT their own proposals.
-- Idempotent: safe to re-run.

create table if not exists public.agent_proposals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded')),
  target     jsonb,   -- proposed target holdings/weights [{symbol, weight, score, beta, reason}]
  trades     jsonb,   -- human-readable buy/sell/trim list at proposal time
  rationale  text,
  commentary text
);

create index if not exists agent_proposals_user_status_idx
  on public.agent_proposals (user_id, status, created_at desc);

alter table public.agent_proposals enable row level security;

-- Owner can read their own proposals (for the review card). No client writes.
drop policy if exists "agent_proposals_select_own" on public.agent_proposals;
create policy "agent_proposals_select_own" on public.agent_proposals
  for select using (auth.uid() = user_id);

grant select on public.agent_proposals to authenticated;

-- The thinker + approve/reject server functions run as service_role.
grant select, insert, update on public.agent_proposals to service_role;
