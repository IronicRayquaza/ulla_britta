-- Fixes a regression introduced by 002_tenancy.sql.
--
-- 002 enabled row level security on `profiles` and `user_preferences` but granted
-- SELECT policies only, on the assumption that every write came from the backend
-- using the service role. That assumption was wrong: the dashboard writes both
-- tables directly from the browser with the anon key.
--
--   onboarding  → user_preferences.upsert  (notification address)
--   onboarding  → profiles.upsert          (onboarding_completed)
--   settings    → user_preferences.upsert  (notification address)
--
-- With RLS on and no INSERT/UPDATE policy, all three silently fail. Onboarding can
-- never record completion, so the auth page keeps finding no profile row and
-- bounces back to onboarding — a login loop.
--
-- Apply with:  psql "$DATABASE_URL" -f migrations/003_client_writes.sql
-- or paste into the Supabase SQL editor. Safe to run after 002 has been applied.

-- ── user_preferences ────────────────────────────────────────────────────────
-- A user owns their own notification settings outright.
drop policy if exists "insert own preferences" on public.user_preferences;
create policy "insert own preferences" on public.user_preferences
    for insert with check (auth.uid() = user_id);

drop policy if exists "update own preferences" on public.user_preferences;
create policy "update own preferences" on public.user_preferences
    for update using (auth.uid() = user_id)
             with check (auth.uid() = user_id);

-- ── profiles ────────────────────────────────────────────────────────────────
-- `with check` on both sides matters: without it on UPDATE, a user could change
-- the user_id of their own row and take ownership of somebody else's.
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
    for insert with check (auth.uid() = user_id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
    for update using (auth.uid() = user_id)
             with check (auth.uid() = user_id);

-- github_username decides which dashboard user an incoming GitHub webhook is
-- attributed to. A user who could set it freely could claim another account's
-- webhook traffic, so the browser is not allowed to write that column at all —
-- only the backend does, from the verified App installation.
--
-- RLS cannot restrict individual columns, so this is a column-level grant. It
-- applies on top of the row policies above.
revoke update (github_username) on public.profiles from authenticated;
revoke insert (github_username) on public.profiles from authenticated;

-- The service role bypasses both RLS and column grants, so the backend is
-- unaffected.

-- ── Verify ──────────────────────────────────────────────────────────────────
-- After applying, this should list select/insert/update for both tables:
--
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('profiles', 'user_preferences')
--    order by tablename, cmd;
