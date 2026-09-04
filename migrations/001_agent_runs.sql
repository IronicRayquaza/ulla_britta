-- Durable agent runs.
--
-- A chat message used to be a single blocking HTTP POST: a repo scaffold or a PR
-- fix that takes minutes would hit Render's request timeout, and nothing about the
-- attempt survived it. Each message is now a persisted run made of ordered steps,
-- so work can be watched live, resumed after a restart, cancelled, and audited.
--
-- Apply with:  psql "$DATABASE_URL" -f migrations/001_agent_runs.sql
-- or paste into the Supabase SQL editor.

-- ── Runs ────────────────────────────────────────────────────────────────────
create table if not exists public.agent_runs (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null,

    -- queued → running → (completed | failed | cancelled | incomplete)
    -- 'incomplete' means a budget ran out before the work was done. It is kept
    -- distinct from 'completed' so a partial run is never reported as a success.
    status        text not null default 'queued'
                  check (status in ('queued','running','completed','failed','cancelled','incomplete')),

    input         text not null,
    result        text,
    error         text,
    stop_reason   text,

    budget        jsonb not null default '{}'::jsonb,
    usage         jsonb not null default '{}'::jsonb,

    created_at    timestamptz not null default now(),
    started_at    timestamptz,
    finished_at   timestamptz
);

create index if not exists agent_runs_user_created_idx
    on public.agent_runs (user_id, created_at desc);

create index if not exists agent_runs_status_idx
    on public.agent_runs (status) where status in ('queued','running');

-- ── Steps ───────────────────────────────────────────────────────────────────
create table if not exists public.agent_steps (
    id            uuid primary key default gen_random_uuid(),
    run_id        uuid not null references public.agent_runs(id) on delete cascade,
    user_id       uuid not null,

    seq           integer not null,
    type          text not null,          -- thinking | tool_call | tool_result | provider_switch | error
    tool_name     text,
    args          jsonb,
    result        jsonb,
    ok            boolean,

    tokens        integer default 0,
    latency_ms    integer default 0,
    created_at    timestamptz not null default now(),

    -- One row per (run, step). Also the idempotency key: a retried task cannot
    -- record — or re-apply — the same side effect twice.
    unique (run_id, seq)
);

create index if not exists agent_steps_run_seq_idx
    on public.agent_steps (run_id, seq);

-- ── Row level security ──────────────────────────────────────────────────────
-- The dashboard reads these with the anon key, so without RLS every user would
-- see every other user's runs.
alter table public.agent_runs  enable row level security;
alter table public.agent_steps enable row level security;

drop policy if exists "own runs" on public.agent_runs;
create policy "own runs" on public.agent_runs
    for select using (auth.uid() = user_id);

drop policy if exists "own steps" on public.agent_steps;
create policy "own steps" on public.agent_steps
    for select using (auth.uid() = user_id);

-- Writes come from the backend using the service role, which bypasses RLS.
-- No insert/update/delete policy is granted to end users on purpose.

-- ── agent_logs ──────────────────────────────────────────────────────────────
-- The dashboard already subscribes to this table with the anon key. If RLS was
-- never enabled on it, every user can read every other user's agent logs.
alter table if exists public.agent_logs enable row level security;

drop policy if exists "own logs" on public.agent_logs;
create policy "own logs" on public.agent_logs
    for select using (auth.uid() = user_id);
