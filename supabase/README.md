# Supabase (backend)

SQL migrations and (later) Edge Functions for PaperTrader live here.

```
supabase/
├── migrations/      ← versioned SQL (apply in order)
└── functions/       ← Edge Functions (added in Phase 5+)
```

## Applying migrations

### Option A — Dashboard SQL Editor (simplest, no CLI needed) ✅ recommended for now

1. Open the project → **SQL Editor** → **New query**.
2. Open `migrations/0001_init_profiles.sql`, copy the **entire** file, paste it in.
3. Click **Run**. You should see "Success. No rows returned."
4. Verify under **Table Editor** that a `profiles` table exists with RLS enabled,
   and under **Database → Triggers** that `on_auth_user_created` exists on `auth.users`.

The migration is idempotent — safe to re-run if needed.

### Option B — Supabase CLI (once linked)

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

## What `0001_init_profiles.sql` does

- Creates `public.profiles` (id → auth.users, display_name, `cash_balance` default **100000**, created_at).
- Enables **Row-Level Security** with owner-only `select` and `update` policies.
- Adds `handle_new_user()` + an `on_auth_user_created` trigger so every new
  signup automatically gets a profile row seeded with **$100,000** — no client
  involvement, so the starting balance can't be tampered with.
