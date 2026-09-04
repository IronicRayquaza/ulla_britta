-- Tenant isolation.
--
-- The dashboard reads several tables directly with the anon key. Without row level
-- security on them, any signed-in user can read every other user's data by asking
-- for it. This also adds the column that makes webhook attribution work at all.
--
-- Apply with:  psql "$DATABASE_URL" -f migrations/002_tenancy.sql
-- or paste into the Supabase SQL editor.

-- ── profiles.github_username ────────────────────────────────────────────────
-- getUserIdByGithubUsername() reads this to attribute an incoming webhook to a
-- user. Nothing ever wrote it, so every webhook fell through to the anonymous
-- system user and its logs reached nobody. The backend now writes it when a
-- GitHub App installation is linked.
alter table public.profiles
    add column if not exists github_username text;

create unique index if not exists profiles_github_username_key
    on public.profiles (lower(github_username))
    where github_username is not null;

-- ── Scoped installation lookups ─────────────────────────────────────────────
-- Every installation lookup is now filtered by user_id and account_login together.
create index if not exists github_installations_user_account_idx
    on public.github_installations (user_id, lower(account_login));

-- ── Row level security ──────────────────────────────────────────────────────
-- Writes all come from the backend using the service role, which bypasses RLS.
-- Only read policies are granted, and only for the caller's own rows.

alter table if exists public.narrations         enable row level security;
alter table if exists public.auto_fixes         enable row level security;
alter table if exists public.user_preferences   enable row level security;
alter table if exists public.github_installations enable row level security;
alter table if exists public.vercel_integrations  enable row level security;
alter table if exists public.profiles           enable row level security;

drop policy if exists "own preferences" on public.user_preferences;
create policy "own preferences" on public.user_preferences
    for select using (auth.uid() = user_id);

drop policy if exists "own installations" on public.github_installations;
create policy "own installations" on public.github_installations
    for select using (auth.uid() = user_id);

drop policy if exists "own vercel integrations" on public.vercel_integrations;
create policy "own vercel integrations" on public.vercel_integrations
    for select using (auth.uid() = user_id);

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
    for select using (auth.uid() = user_id);

-- narrations and auto_fixes are keyed by installation_id rather than user_id, so
-- ownership is resolved through the installations table.
drop policy if exists "own narrations" on public.narrations;
create policy "own narrations" on public.narrations
    for select using (
        installation_id in (
            select installation_id from public.github_installations
            where user_id = auth.uid()
        )
    );

drop policy if exists "own fixes" on public.auto_fixes;
create policy "own fixes" on public.auto_fixes
    for select using (
        installation_id in (
            select installation_id from public.github_installations
            where user_id = auth.uid()
        )
    );

-- ── Note on existing rows ───────────────────────────────────────────────────
-- Rows written before this migration may carry the placeholder user id that the
-- old code used as a fallback ('a66ceed4-...' and the all-zero system id). They
-- will simply not be visible to anyone once RLS is on. Reassign them to a real
-- user if you want them back, for example:
--
--   update public.agent_logs
--      set user_id = '<your-auth-user-id>'
--    where user_id = 'a66ceed4-63a5-405a-85b5-9f8f59946690';
