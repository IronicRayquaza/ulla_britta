-- GitHub user-to-server tokens.
--
-- The App's installation token is the right credential for repository work, but
-- GitHub refuses a whole class of endpoints to it: creating a repository on a
-- personal account (POST /user/repos), starring, following, the notification
-- inbox, and creating gists are all user-to-server only. Without somewhere to keep
-- a user token, the agent could not do any of them — "can you start a new repo and
-- push it to my github" failed for exactly this reason once the missing-Octokit-
-- method bug behind it was fixed.
--
-- This table is optional. With GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET unset, no row
-- is ever written and the user-scoped tools fail with an explanation instead.
--
-- Apply with:  psql "$DATABASE_URL" -f migrations/005_github_user_tokens.sql
-- or paste into the Supabase SQL editor.

create table if not exists public.github_user_tokens (
    user_id                  uuid primary key references auth.users (id) on delete cascade,
    access_token             text        not null,
    refresh_token            text,
    expires_at               timestamptz,
    refresh_token_expires_at timestamptz,
    github_login             text,
    scope                    text,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

comment on table public.github_user_tokens is
    'GitHub user-to-server OAuth tokens. Server-side only: never exposed to the browser.';

-- ── Row level security ──────────────────────────────────────────────────────
-- Deliberately stricter than every other table here. The dashboard reads several
-- tables directly with the anon key under an "own rows" select policy; that is
-- fine for narrations and installation ids, and it is NOT fine for a credential
-- that can act on the user's whole GitHub account. RLS is enabled with no policy
-- at all, so the anon and authenticated roles can read nothing. Only the backend,
-- holding the service role, can touch it.
alter table public.github_user_tokens enable row level security;

drop policy if exists "own github user token" on public.github_user_tokens;

revoke all on public.github_user_tokens from anon, authenticated;

create index if not exists github_user_tokens_login_idx
    on public.github_user_tokens (lower(github_login))
    where github_login is not null;
