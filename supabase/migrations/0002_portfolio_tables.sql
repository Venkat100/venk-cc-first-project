-- 0002_portfolio_tables.sql
-- PaperTrader — Phase 4 (database & portfolio plumbing).
-- Per-user tables: holdings, transactions (append-only ledger), watchlist.
-- Every table is owner-only via Row-Level Security.
--
-- Safe to run more than once (idempotent guards throughout).
-- Apply via the Supabase dashboard SQL Editor. See supabase/README.md.

-- ──────────────────────────────────────────────────────────────
-- holdings — current positions (one row per user per symbol)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.holdings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  quantity   numeric not null,
  avg_cost   numeric not null,
  updated_at timestamptz not null default now(),
  unique (user_id, symbol)
);

create index if not exists holdings_user_id_idx on public.holdings (user_id);

alter table public.holdings enable row level security;

drop policy if exists "holdings_select_own" on public.holdings;
create policy "holdings_select_own" on public.holdings
  for select using (auth.uid() = user_id);

drop policy if exists "holdings_insert_own" on public.holdings;
create policy "holdings_insert_own" on public.holdings
  for insert with check (auth.uid() = user_id);

drop policy if exists "holdings_update_own" on public.holdings;
create policy "holdings_update_own" on public.holdings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "holdings_delete_own" on public.holdings;
create policy "holdings_delete_own" on public.holdings
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.holdings to authenticated;

-- ──────────────────────────────────────────────────────────────
-- transactions — immutable, append-only ledger of every buy/sell
-- ──────────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  side       text not null check (side in ('buy', 'sell')),
  quantity   numeric not null,
  price      numeric not null,
  total      numeric not null,
  order_type text not null default 'market',
  status     text not null default 'filled',
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_created_idx
  on public.transactions (user_id, created_at desc);

alter table public.transactions enable row level security;

drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own" on public.transactions
  for select using (auth.uid() = user_id);

drop policy if exists "transactions_insert_own" on public.transactions;
create policy "transactions_insert_own" on public.transactions
  for insert with check (auth.uid() = user_id);

-- Deliberately NO update/delete policy: the ledger is append-only. Even the
-- owner cannot modify or remove a transaction from the client.
grant select, insert on public.transactions to authenticated;

-- ──────────────────────────────────────────────────────────────
-- watchlist — followed symbols (one row per user per symbol)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  symbol     text not null,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);

create index if not exists watchlist_user_id_idx on public.watchlist (user_id);

alter table public.watchlist enable row level security;

drop policy if exists "watchlist_select_own" on public.watchlist;
create policy "watchlist_select_own" on public.watchlist
  for select using (auth.uid() = user_id);

drop policy if exists "watchlist_insert_own" on public.watchlist;
create policy "watchlist_insert_own" on public.watchlist
  for insert with check (auth.uid() = user_id);

drop policy if exists "watchlist_delete_own" on public.watchlist;
create policy "watchlist_delete_own" on public.watchlist
  for delete using (auth.uid() = user_id);

grant select, insert, delete on public.watchlist to authenticated;
