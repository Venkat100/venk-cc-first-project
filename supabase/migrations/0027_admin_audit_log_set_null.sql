-- 0027_admin_audit_log_set_null.sql
-- Corrects a design mistake in 0026_admin_console.sql: admin_audit_log's
-- admin_id was ON DELETE RESTRICT, which sounded like the right way to
-- protect an audit trail but actually got the protected THING wrong. It
-- protected the ACCOUNT ROW (making any account that ever performed an
-- admin action permanently undeletable) instead of protecting the HISTORY
-- itself. Two concrete problems this caused:
--   1. It blocked deleting a throwaway admin test account after a live
--      verification pass — exactly the kind of routine cleanup an audit
--      constraint should never be in the way of.
--   2. It would collide with this product's own privacy policy, which
--      promises users a deletion right. If a real user ever briefly held
--      is_admin (support duty, a mistake, anything), RESTRICT would make
--      their account permanently undeletable the moment they performed one
--      admin action — a real compliance problem, not a theoretical one.
--
-- The fix follows the pattern already used elsewhere in this schema for
-- exactly this situation — analytics_events, and this table's OWN
-- target_user_id column two lines below in 0026 — ON DELETE SET NULL, with
-- the human-readable identity (admin_email) captured at write time so the
-- record stays fully readable after the account is gone. That capture
-- already existed from day one (0026's admin_set_suspended/admin_log_action
-- both write admin_email in the same insert as admin_id, reading it from
-- auth.users inside a SECURITY DEFINER function — never client-supplied),
-- so this migration only needs to change what happens on delete, not add
-- any new write path.
--
-- The corrected invariant, stated precisely: **the audit HISTORY is
-- immutable — not the account row.** A row can never be edited or deleted
-- (admin_audit_log still has no update/delete grant to any role, unchanged
-- by this migration — see the verification below). Which human performed
-- an action is preserved forever via admin_email even once the account
-- itself is gone; admin_id becoming null is simply "the account no longer
-- exists," visible and honest, not a hole in the record.

-- Defensive backfill (expected to be a no-op): admin_email has been
-- `not null` since 0026 and both writer functions have always populated it
-- at insert time, so no existing row should ever be missing it. Included
-- anyway as a real safety net, not a formality — if it ever finds a row,
-- that's a bug worth knowing about, and this closes it before the FK
-- change below makes admin_id no longer a reliable fallback join key.
update public.admin_audit_log a
set admin_email = u.email
from auth.users u
where a.admin_id = u.id
  and (a.admin_email is null or a.admin_email = '');

-- Drop the existing FK by introspection rather than a hardcoded name —
-- Postgres's auto-generated name for an inline `references` constraint is
-- a convention, not a guarantee, and getting this wrong would silently
-- no-op instead of failing loudly.
do $$
declare
  v_conname text;
begin
  select tc.constraint_name into v_conname
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
  where tc.table_schema = 'public'
    and tc.table_name = 'admin_audit_log'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'admin_id';

  if v_conname is null then
    raise exception 'could not find the admin_id foreign key on admin_audit_log — aborting rather than silently no-op-ing';
  end if;

  execute format('alter table public.admin_audit_log drop constraint %I', v_conname);
end $$;

-- ON DELETE SET NULL requires the column to accept null.
alter table public.admin_audit_log alter column admin_id drop not null;

alter table public.admin_audit_log
  add constraint admin_audit_log_admin_id_fkey
  foreign key (admin_id) references auth.users (id) on delete set null;

-- Immutability is unchanged and re-asserted here for clarity, not because
-- anything above touched it: still select+insert only, to service_role
-- only, no update/delete grant to any role, ever.
