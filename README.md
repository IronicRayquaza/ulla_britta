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
Gemini and hits a rate limit continues on the next tier **with its full history**,
rather than restarting with amnesia. The ladder is `gemini` → `gemini-lite`
(same key, larger free allowance) → `groq` → `openrouter`.

Failures are sorted by whose fault they are. A throttle is retried in place once;
an unknown model, a rejected key or an over-budget request is that **provider's**
problem, so the run moves to the next one; only a genuinely malformed request stops
everything. Model ids rot — two shipped defaults were decommissioned upstream
without anyone noticing — so `src/providers/preflight.mjs` checks each configured
model against the provider's live catalogue at boot and says what to set instead.
See [docs/AGENT_CAPABILITIES.md](docs/AGENT_CAPABILITIES.md#troubleshooting).

### What it can reach

`src/agent/tools/` is the capability surface, one module per GitHub domain:
repositories, files, git history, issues, pull requests, Actions, releases, people
and insight. **[docs/AGENT_CAPABILITIES.md](docs/AGENT_CAPABILITIES.md) is the map**
— its inventory is generated from the registry, so it cannot drift from the code.

```bash
npm run docs:capabilities        # regenerate it after adding a tool
```

Two credentials reach GitHub, and they are not interchangeable. The **installation
token** does repository work. A **user token** is needed for the handful of
endpoints GitHub refuses to anything that is not the person — creating a repository
on a personal account, starring, following, notifications, gists. The second is
optional; without it those tools fail with an instruction instead of a 403.

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
npm test                 # 336 checks, no network needed
npm start
```

At least one of `GEMINI_API_KEY`, `GROQ_API_KEY` or `OPENROUTER_API_KEY` is
required. Gemini's free tier carries normal load.

Note that a **free Groq key cannot run this agent**: its 8,000-token per-request
cap is smaller than the ~12,000-token tool schema, so every call is refused with a
413. The router steps over it and the boot log says so. Groq needs a raised limit
to be a useful tier.

### Database

Apply the migrations before first use:

```bash
psql "$DATABASE_URL" -f migrations/001_agent_runs.sql
psql "$DATABASE_URL" -f migrations/002_tenancy.sql
psql "$DATABASE_URL" -f migrations/003_client_writes.sql
psql "$DATABASE_URL" -f migrations/004_upsert_keys.sql
psql "$DATABASE_URL" -f migrations/005_github_user_tokens.sql
```

Or paste them into the Supabase SQL editor. Without `001` the agent still runs and
streams, but nothing is saved — it warns once and carries on. `002` adds
`profiles.github_username` (which webhook attribution depends on) and enables row
level security; **without it, any signed-in user can read every other user's data**
through the anon key. `005` holds GitHub user tokens and is only needed if you
configure `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`.

### Acting as the user (optional)

GitHub refuses `POST /user/repos`, starring, following, notifications and gists to
an installation token. To let the agent do them, set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` from the same GitHub App, enable **Request user
authorization (OAuth) during installation** on it, and apply migration `005`. The
user then connects once from dashboard Settings. Leave it unset and the rest of the
agent is unaffected.

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
| `narration` | Runs are legible: what it is doing, and the evidence it did it |
| `capabilities` | Every Octokit method called exists; the registry and the docs agree |
| `tool-smoke` | Every read-only tool answers for real against a stand-in GitHub |
| `preflight` | A decommissioned or over-budget model is caught at boot, not mid-run |

They run offline in about two seconds.
