-- Diagnostic. Reads only — changes nothing.
-- Paste into the Supabase SQL editor and send back the output.
--
-- The login loop has two possible causes left, and these queries tell them apart.

-- 1. Does profiles have the columns and the UNIQUE constraint the app relies on?
--    The dashboard upserts with onConflict: "user_id". Postgres rejects that with
--    error 42P10 unless user_id carries a unique index — and a stock Supabase
--    profiles table is keyed on `id`, not `user_id`.
select
    'profiles columns' as check,
    string_agg(column_name, ', ' order by ordinal_position) as value
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'

union all

select
    'user_preferences columns',
    string_agg(column_name, ', ' order by ordinal_position)
from information_schema.columns
where table_schema = 'public' and table_name = 'user_preferences'

union all

-- 2. Unique indexes. Look for one on user_id in each table.
select
    'unique indexes on ' || tablename,
    string_agg(indexdef, ' | ')
from pg_indexes
where schemaname = 'public'
  and tablename in ('profiles', 'user_preferences')
  and indexdef ilike '%unique%'
group by tablename

union all

-- 3. Which policies actually exist now. Both tables should show select,
--    insert and update after 003 is applied.
select
    'policies on ' || tablename,
    string_agg(policyname || ' [' || cmd || ']', ', ' order by cmd)
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'user_preferences')
group by tablename

union all

-- 4. Is RLS on at all?
select
    'rls enabled',
    string_agg(relname || '=' || relrowsecurity::text, ', ')
from pg_class
where relname in ('profiles', 'user_preferences')

union all

-- 5. Is there a profile row for the account that is stuck?
select
    'profile rows for stuck user',
    count(*)::text
from public.profiles
where user_id = 'a66ceed4-63a5-405a-85b5-9f8f59946690';
