-- Durable Postgres price cache (PLAN.md §6 step 2, pulled forward from
-- Phase D — sketched in ARCHITECTURE.md §3). Production runs on Vercel
-- serverless: in-process module memory (the existing `cache.server.ts`
-- in-memory Map) dies between invocations, so today N users watching the
-- same symbol within a TTL window can each trigger their own provider call
-- — every user's browsing consumes the SAME global rate limit (Finnhub
-- 60 req/min, Twelve Data ~8 credits/min, shared across ALL users). This
-- table is the durable L2 tier underneath that in-memory L1: once ANY
-- invocation fetches a symbol, every other invocation (same process or a
-- brand new cold one) reads the same row instead of re-hitting the
-- provider, for as long as the row is fresh. Goal: N users watching AAPL
-- costs ONE provider call per interval, not N.
--
-- SCHEMA: keyed by (kind, symbol, interval) rather than one opaque string
-- key, matching every current cache-key shape used across the app:
--   kind='quote',      symbol='AAPL',  interval=''      (no natural interval)
--   kind='candles',    symbol='AAPL',  interval='3M'    (range)
--   kind='search',     symbol='AAPL INFOSYS' (normalized query text), interval=''
--   kind='profile'/'metrics', symbol='AAPL', interval=''
-- `interval` is NOT NULL with a default of '' (not nullable) specifically so
-- it can sit in the primary key — Postgres primary keys can't contain NULL.
--
-- NOT user data: no per-user column, no RLS needed (RLS is for isolating
-- rows BETWEEN users; this table has no user to isolate). Locked down by
-- grant instead, same posture as `insights`' shared kind='stock' rows —
-- service_role only, in both directions. Clients must never read or write
-- this table directly: every value here is either a straight passthrough of
-- upstream provider data (a licensing/ToS question, not a security one, but
-- still server-only by design) or would let a client see OTHER users'
-- warmed cache entries as a side channel for what symbols are popular.

create table if not exists public.price_cache (
  kind        text not null,
  symbol      text not null,
  interval    text not null default '',
  payload     jsonb not null,
  fetched_at  timestamptz not null default now(),
  primary key (kind, symbol, interval)
);

-- Retention/prune path (the task this table itself exists to avoid — see
-- the `insights` table, which has accumulated forever with no delete grant
-- until 0017). One btree index on fetched_at supports both directions of
-- the actual query pattern: "is this specific (kind,symbol,interval) row
-- still fresh" (served by the primary key) and "delete everything older
-- than N days" (served by this index, not a full-table scan).
create index if not exists price_cache_fetched_at_idx
  on public.price_cache (fetched_at);

alter table public.price_cache enable row level security;
-- No policies created: RLS with zero policies denies ALL access to every
-- role EXCEPT the table owner and roles with BYPASSRLS (service_role has
-- neither by default in Supabase, so this is a real, enforced deny — not
-- security theater). Matches the `insights`-table precedent for a
-- service-role-only table that still gets RLS enabled defensively.

revoke all on public.price_cache from public;
revoke all on public.price_cache from anon;
revoke all on public.price_cache from authenticated;
grant select, insert, update, delete on public.price_cache to service_role;
