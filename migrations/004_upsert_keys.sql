-- The unique constraints the dashboard's upserts depend on.
--
-- Both the onboarding page and the settings page write with
-- `.upsert(..., { onConflict: "user_id" })`. Postgres rejects that outright —
-- error 42P10, "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification" — unless user_id carries a unique index. A stock
-- Supabase `profiles` table is keyed on `id`, so a separately added `user_id`
-- column usually has no such index and every upsert fails.
--
-- This has nothing to do with row level security: it would fail the same way with
-- RLS off. It is the second half of the login loop.
--
-- Apply with:  psql "$DATABASE_URL" -f migrations/004_upsert_keys.sql
-- Safe to run more than once.

-- ── profiles.user_id ────────────────────────────────────────────────────────
-- Duplicates would make this fail. Check first if you expect any:
--   select user_id, count(*) from public.profiles group by user_id having count(*) > 1;
create unique index if not exists profiles_user_id_key
    on public.profiles (user_id);

-- ── user_preferences.user_id ────────────────────────────────────────────────
create unique index if not exists user_preferences_user_id_key
    on public.user_preferences (user_id);

-- ── github_installations ────────────────────────────────────────────────────
-- The backend upserts on installation_id; give it the same guarantee.
create unique index if not exists github_installations_installation_id_key
    on public.github_installations (installation_id);

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Should list one unique index on user_id for each of the first two tables:
--
--   select tablename, indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename in ('profiles', 'user_preferences')
--      and indexdef ilike '%unique%';
