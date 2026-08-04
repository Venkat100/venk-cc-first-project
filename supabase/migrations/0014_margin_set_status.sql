-- 0014_margin_set_status.sql
-- Real production bug, found by the M1 live-verification run (not a script
-- bug): lib/margin/monitor.server.ts writes `margin_status` via a raw
-- `admin.from("profiles").update(...)` PostgREST call, in two places (the
-- initial ok→warning/call transition, and the post-liquidation status
-- write) — but `service_role` has NEVER had a table-level UPDATE grant on
-- `profiles` (see 0013's header for the full story). Both writes have been
-- silently failing since M1 shipped: PostgREST returned a 42501 permission
-- error, and the monitor never checked it. The 'warning'/'call' AUDIT
-- EVENTS still logged correctly (margin_events has its own proper grant),
-- but the `margin_status` COLUMN itself never actually persisted a
-- transition written by the monitor — only the SECURITY DEFINER trade
-- functions' own inline `margin_status = case when ... then 'ok' ...` resets
-- ever took effect, since those run as the function owner. Caught live: a
-- forced 'ok'→'warning' scenario showed the correct in-memory transition and
-- a correctly-logged event, but a fresh read-back of the row still showed
-- 'ok'.
--
-- Fixed at the root with a dedicated, narrow SECURITY DEFINER RPC for
-- exactly this write (same shape as every other margin state mutation in
-- this schema), service_role-only EXECUTE, validating the status value.
-- monitor.server.ts is updated in the same change to call this RPC instead
-- of the raw table update, and to actually check the returned error.
create or replace function public.set_margin_status(
  p_user_id uuid,
  p_status  text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('ok', 'warning', 'call') then
    raise exception 'invalid_status';
  end if;

  update public.profiles set margin_status = p_status where id = p_user_id;

  if not found then
    raise exception 'profile_not_found';
  end if;

  return jsonb_build_object('margin_status', p_status);
end;
$$;

revoke all on function public.set_margin_status(uuid, text) from public;
revoke all on function public.set_margin_status(uuid, text) from anon;
revoke all on function public.set_margin_status(uuid, text) from authenticated;
grant execute on function public.set_margin_status(uuid, text) to service_role;
