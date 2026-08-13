-- 0026_admin_console.sql
-- PLAN.md §6 step 10 (B4) — super-admin console.
--
-- THREAT MODEL for `profiles.is_admin` (the single most security-sensitive
-- flag in this schema, more sensitive than any money column): a user who
-- can set their own is_admin to true can read every other user's account
-- summary and suspend/delete any account. It must be STRUCTURALLY
-- impossible for any client, and any of our own server code, to grant
-- itself admin. Concretely:
--   • `authenticated` has NEVER had table-level UPDATE on `profiles` — only
--     a narrow column grant `update (display_name)` (0012_margin.sql). That
--     grant does not cover is_admin, so a client PATCH/RPC call attempting
--     `update profiles set is_admin = true` is rejected by Postgres itself
--     (42501 permission denied) before RLS is even consulted.
--   • `service_role` has SELECT on profiles (0004) but has NEVER had
--     UPDATE, and this migration does not grant it one. There is
--     deliberately no `admin_grant_admin(...)`-style RPC anywhere in this
--     migration or any future one is expected to add — the ONLY way
--     is_admin is ever set is a superuser SQL session (the Supabase
--     dashboard's SQL editor), run manually, out of band, by Venky. No
--     code path in this application can create an admin. This is stronger
--     than an RPC gated by "only an existing admin can promote someone" —
--     it removes the promotion feature entirely rather than trying to
--     secure it.
--   • Every admin-only server function independently re-verifies is_admin
--     server-side (via requireAdmin(), lib/admin/requireAdmin.server.ts)
--     from the JWT-derived user id — never a client-supplied claim, and
--     never inferred from "the nav item was visible."
--
-- `profiles.suspended_at` (nullable timestamptz, matching the established
-- terms_accepted_at/options_unlocked_at "null=off" convention) is a
-- DENORMALIZED CACHE for fast admin-console listing/display only — the
-- actual login-blocking enforcement is Supabase Auth's own native ban
-- (`auth.admin.updateUserById(uid, {ban_duration})`), which blocks both new
-- sign-in AND token refresh at the GoTrue layer itself, so a suspended user
-- can never obtain a fresh session. This column and that native ban are
-- always written together (setUserSuspendedFn, lib/admin/functions.ts) so
-- they can't drift, but if they ever did, the GoTrue ban is authoritative
-- for actual access; this column is authoritative for what the console
-- displays. Deliberately NOT wired into any RLS policy — doing so would
-- touch 15+ existing, already-hardened policies for a case ("instantly
-- revoke an already-issued, unexpired JWT mid-session") beyond what was
-- asked ("blocks login"); the accepted tradeoff is documented here, not
-- silent.
alter table public.profiles
  add column if not exists is_admin boolean not null default false,
  add column if not exists suspended_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_audit_log — every admin action, immutable. "An admin console
-- without an audit trail is a liability" (kickoff, verbatim). Structurally
-- append-only: the grant list below has NO update, NO delete, not even for
-- service_role — there is no grant path in this schema, ever, for any
-- application code to alter or erase a row here, same shape as
-- scenario_transactions/agent_decisions/agent_transactions (all append-only
-- by omitting UPDATE even from service_role).
--
-- admin_email/target_email are captured AT WRITE TIME (read directly from
-- auth.users inside the SECURITY DEFINER functions below, which run with
-- full schema access — not through PostgREST's public/graphql_public-only
-- exposure) rather than trusting a caller-supplied string, and rather than
-- joining auth.users at read time (target_user_id survives a later delete
-- via ON DELETE SET NULL, but the email snapshot must survive it too, or a
-- "deleted this user" audit row would become unreadable the moment the
-- delete it's recording succeeds).
create table if not exists public.admin_audit_log (
  id              uuid primary key default gen_random_uuid(),
  admin_id        uuid not null references auth.users (id) on delete restrict,
  admin_email     text not null,
  action          text not null,
  target_user_id  uuid references auth.users (id) on delete set null,
  target_email    text,
  detail          jsonb,
  created_at      timestamptz not null default now()
);
-- ON DELETE RESTRICT for admin_id (not cascade, not set null): an admin
-- cannot make their own audit history disappear by deleting their account.
-- At this project's scale (one admin, Venky) this is a theoretical guard,
-- not friction in practice — deleting any account that has ever performed
-- an admin action will require a superuser to first decide what to do with
-- that history, which is the correct default for an audit trail.
--
-- 🔄 SUPERSEDED 2026-08-13 by 0027_admin_audit_log_set_null.sql. In
-- practice this protected the wrong thing: it made the ACCOUNT ROW
-- undeletable rather than protecting the HISTORY, which blocked routine
-- test-account cleanup and would collide with this product's own
-- privacy-policy deletion right for any real admin. 0027 changes this to
-- ON DELETE SET NULL — admin_email (already captured at write time, see
-- above) is the durable, human-readable record of who acted; the audit
-- HISTORY is what stays immutable, not the account. Left here unedited,
-- as applied, for an accurate record of what actually ran — see 0027 for
-- the corrected design and reasoning.

create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_admin_idx on public.admin_audit_log (admin_id, created_at desc);
create index if not exists admin_audit_log_target_idx on public.admin_audit_log (target_user_id, created_at desc);

alter table public.admin_audit_log enable row level security;
-- No policies created: RLS-with-zero-policies denies ALL access to every
-- role except BYPASSRLS, same enforced-deny pattern as rate_limit_events/
-- analytics_events/cron_heartbeats — service_role only.
revoke all on public.admin_audit_log from public;
revoke all on public.admin_audit_log from anon;
revoke all on public.admin_audit_log from authenticated;
grant select, insert on public.admin_audit_log to service_role; -- deliberately no update/delete, ever

-- ─────────────────────────────────────────────────────────────────────────
-- admin_set_suspended — the ONLY write path for profiles.suspended_at.
-- Re-verifies p_admin_id is actually an admin INSIDE the function (defense
-- in depth beyond the TS-layer requireAdmin() check — matches this
-- project's standing rule that hiding a nav item is never the security
-- boundary) and writes the audit row in the SAME transaction as the state
-- change, so the two can never diverge: either both happen or neither does.
create or replace function public.admin_set_suspended(
  p_admin_id       uuid,
  p_target_user_id uuid,
  p_suspended      boolean
) returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin     boolean;
  v_target_email text;
  v_row          public.profiles;
begin
  select is_admin into v_is_admin from public.profiles where id = p_admin_id;
  if v_is_admin is not true then
    raise exception 'not_admin: caller is not an administrator';
  end if;

  if p_admin_id = p_target_user_id then
    raise exception 'cannot_suspend_self: an admin cannot suspend their own account';
  end if;

  select email into v_target_email from auth.users where id = p_target_user_id;
  if v_target_email is null then
    raise exception 'user_not_found: no such user';
  end if;

  update public.profiles
    set suspended_at = case when p_suspended then now() else null end
    where id = p_target_user_id
    returning * into v_row;

  if not found then
    raise exception 'user_not_found: no profile for target user';
  end if;

  insert into public.admin_audit_log (admin_id, admin_email, action, target_user_id, target_email, detail)
    values (
      p_admin_id,
      (select email from auth.users where id = p_admin_id),
      case when p_suspended then 'suspend_user' else 'unsuspend_user' end,
      p_target_user_id,
      v_target_email,
      jsonb_build_object('suspended', p_suspended)
    );

  return v_row;
end;
$$;

revoke all on function public.admin_set_suspended(uuid, uuid, boolean) from public;
revoke all on function public.admin_set_suspended(uuid, uuid, boolean) from anon;
revoke all on function public.admin_set_suspended(uuid, uuid, boolean) from authenticated;
grant execute on function public.admin_set_suspended(uuid, uuid, boolean) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_log_action — generic audit-row writer for admin actions that don't
-- have their own dedicated state-changing RPC (viewing a user's summary,
-- deleting a user via the Supabase Admin API rather than a table write).
-- Same admin re-verification as admin_set_suspended.
create or replace function public.admin_log_action(
  p_admin_id       uuid,
  p_action         text,
  p_target_user_id uuid default null,
  p_detail         jsonb default null
) returns public.admin_audit_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin     boolean;
  v_target_email text;
  v_row          public.admin_audit_log;
begin
  select is_admin into v_is_admin from public.profiles where id = p_admin_id;
  if v_is_admin is not true then
    raise exception 'not_admin: caller is not an administrator';
  end if;

  if p_target_user_id is not null then
    select email into v_target_email from auth.users where id = p_target_user_id;
  end if;

  insert into public.admin_audit_log (admin_id, admin_email, action, target_user_id, target_email, detail)
    values (
      p_admin_id,
      (select email from auth.users where id = p_admin_id),
      p_action,
      p_target_user_id,
      v_target_email,
      p_detail
    )
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_log_action(uuid, text, uuid, jsonb) from public;
revoke all on function public.admin_log_action(uuid, text, uuid, jsonb) from anon;
revoke all on function public.admin_log_action(uuid, text, uuid, jsonb) from authenticated;
grant execute on function public.admin_log_action(uuid, text, uuid, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- journal_entries stays completely untouched by this migration — no grant
-- to service_role is added here. See 0023_journal.sql's own header for the
-- full reasoning: journal entries are the most personal data in this
-- product, and withholding the service_role grant means even our own
-- server tooling — including this admin console — structurally CANNOT
-- read them. That guarantee is enforced by Postgres, not by the admin
-- console's own code choosing not to query the table. Do not add a grant
-- here. Do not work around it.
