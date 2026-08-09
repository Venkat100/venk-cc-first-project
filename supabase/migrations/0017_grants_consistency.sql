-- Consistency fix, not a new feature. Two long-documented grant gaps closed:
--
-- 1. public.transactions never granted service_role SELECT. Every sibling
--    ledger table (option_transactions, agent_transactions, margin_events)
--    has had `grant select ... to service_role` since the migration that
--    created it (0010/0006/0012) — transactions was the lone exception, an
--    oversight in 0002 (written before service_role ever needed to read
--    user tables directly), not a deliberate security posture. It has bitten
--    verification scripts twice now (R2's `verify-r2-*`, and the account-
--    deletion test in the account-management work) — both times worked
--    around by reading via the user's own authenticated session instead,
--    which works for a LIVE user but structurally cannot verify a table
--    post-deletion, since that session no longer exists. This grant closes
--    that gap for good. Server-only: no RLS policy changes, `authenticated`
--    keeps its existing select+insert, no new client-visible surface.
--
-- 2. public.insights never granted service_role DELETE (0009 granted only
--    select/insert/update). Flagged as a backlog item since V1 Insights
--    shipped: insight rows (one per symbol/day, globally shared, forever)
--    and daily-brief rows (one per user/day) currently accumulate with NO
--    way to prune them, even by the server. Not urgent at today's volume,
--    but a real, growing gap — the exact failure mode a durable price_cache
--    (this same build step) must avoid from day one. Granting DELETE now
--    means a future retention job needs no further schema change.

grant select on public.transactions to service_role;
grant delete on public.insights to service_role;
