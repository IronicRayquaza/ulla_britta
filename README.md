# Ulla Britta

An agent that operates your GitHub account. You describe what you want in the
dashboard — review these pull requests, fix the failing one, check what is
outdated — and it plans, acts, and reports what it actually did.

## Architecture

Three processes, one image.

| Process | Entry point | What it does |
|---|---|---|
| Receiver | `src/index.mjs` | GitHub and Vercel webhooks, the run API, SSE streams |
| Worker | `src/worker.mjs` | Executes runs and webhook events; hosts the Vercel sentinel |
| Maintenance | `src/maintenance.mjs` | One scheduled sweep, then exits. For a platform cron job. |

`npm start` runs the receiver and worker together (`src/solo_start.mjs`), which is
what the Procfile and the Docker image use.

```
Browser ──POST /api/runs──▶ Receiver ──Redis queue──▶ Worker
   ▲                                                    │
   └────────── SSE ◀── Redis pub/sub ◀──────────────────┘
```

A message becomes a persisted **run** made of ordered **steps**. The browser
watches it live and can cancel it; a reload replays the run from the database
rather than losing it.

### The agent

`src/agent/` holds the loop. It runs think → act → observe until the model stops
calling tools or a budget (steps, tokens, wall-clock) is spent — there is no fixed
round limit. Tools return structured results, so a retryable failure and a
permission failure are different things to the model.

`src/providers/` normalises messages across providers, so a run that starts on
Gemini and hits a rate limit continues on Groq **with its full history**, rather
than restarting with amnesia.

Two rules the code enforces rather than the prompt:

- **Irreversible actions need confirmation.** `delete_repository` is refused on
  first call. The confirmation is single-use, bound to exact arguments, expires,
  and must arrive on a later user turn, so the agent cannot confirm its own action
  mid-loop.
- **Never claim unverified success.** An incomplete run says so and lists what
  actually ran, split into completed and failed.

## Setup

```bash
cp .env.example .env     # then fill it in
npm install
npm test                 # 167 checks, no network needed
npm start
```

At least one of `GEMINI_API_KEY`, `GROQ_API_KEY` or `OPENROUTER_API_KEY` is
required. Gemini's free tier carries normal load; Groq takes over when it throttles.

### Database

Apply the migrations before first use:

```bash
psql "$DATABASE_URL" -f migrations/001_agent_runs.sql
psql "$DATABASE_URL" -f migrations/002_tenancy.sql
```

Or paste them into the Supabase SQL editor. Without `001` the agent still runs and
streams, but nothing is saved — it warns once and carries on. `002` adds
`profiles.github_username` (which webhook attribution depends on) and enables row
level security; **without it, any signed-in user can read every other user's data**
through the anon key.

### Scheduled maintenance

`npm run maintenance` performs one sweep and exits. Point a platform cron job at
it — daily is reasonable. It is deliberately not a timer inside the web process,
which does not fire on a service that sleeps between requests.

## Deployment

Render uses the `Procfile`. The `Dockerfile` builds the same three processes for
`docker compose up` or any container host. `docker compose run --rm maintenance`
runs a sweep locally.

Set `FRONTEND_URL` to the deployed dashboard origin or CORS will reject it.

## Frontend

The dashboard is a separate Next.js app. It needs:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_BACKEND_URL=
```

Every request carries the signed-in user's Supabase token; the backend derives the
user from it and never reads an identity from the request body.

## Tests

`npm test` runs the safety suites. They cover the properties that must not
regress:

| Suite | Covers |
|---|---|
| `providers` | Message round-trips per provider; failover keeps history |
| `agent-loop` | Multi-step tasks finish; budgets stop honestly; failures reach the model |
| `destructive-gate` | Irreversible actions cannot run without a later-turn confirmation |
| `honest-failure` | Success is never reported for work that did not happen |
| `runs` | Idempotent retries, step ordering, cancellation, graceful degradation |
| `diff` | Review comments only anchor to lines that exist in the diff |
| `pr` | Fixes only touch files the PR changed, on the PR branch |
| `tenancy` | A user cannot reach another tenant's installation; raw-byte signatures |

They run offline in about two seconds.
