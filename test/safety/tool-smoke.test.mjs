import databaseService from '../../src/services/database.service.mjs';
import githubService from '../../src/services/github.service.mjs';
import { buildRegistry } from '../../src/agent/tools/index.mjs';
import { clearRepoIndexCache } from '../../src/agent/github-access.mjs';
import { narrateStart, narrateResult } from '../../src/agent/narration.mjs';
import { check, report } from './harness.mjs';

/**
 * Every read-only tool, executed end to end against a stand-in GitHub.
 *
 * The static check proves the Octokit methods exist. It cannot prove a handler
 * reads the right field off the response, so a tool can pass it and still return
 * `undefined` for everything a person asked about. This runs each one and insists
 * on a real answer coming back out — and that the narration of that answer says
 * something, since the narrator is what the user actually reads.
 *
 * Only read-only tools are exercised. A fake that accepts writes proves nothing
 * about writes, and the destructive gate has its own suite.
 */

// ── A GitHub that answers plausibly ─────────────────────────────────────────

const REPO = {
    full_name: 'acme/api', name: 'api', owner: { login: 'acme' },
    description: 'The API', private: false, fork: false, archived: false,
    default_branch: 'main', language: 'JavaScript', stargazers_count: 12,
    forks_count: 3, open_issues_count: 4, topics: ['api'], size: 900,
    license: { spdx_id: 'MIT' }, pushed_at: '2026-09-01T00:00:00Z',
    html_url: 'https://github.com/acme/api', node_id: 'PR_1'
};

const USER = {
    login: 'acme', name: 'Acme', type: 'User', bio: 'builds things',
    company: null, location: 'Berlin', blog: '', email: null,
    followers: 42, following: 7, public_repos: 9, public_gists: 2,
    created_at: '2020-01-01T00:00:00Z', html_url: 'https://github.com/acme'
};

const ISSUE = {
    number: 7, title: 'Cache is stale', state: 'open', user: { login: 'someone' },
    labels: [{ name: 'bug' }], assignees: [{ login: 'acme' }], comments: 2,
    body: 'It goes stale after an hour.', milestone: { title: 'v1' },
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z',
    closed_at: null, html_url: 'https://github.com/acme/api/issues/7'
};

const PR = {
    ...ISSUE, number: 11, title: 'Add caching', draft: false, merged: false,
    mergeable: true, head: { ref: 'feat/cache' }, base: { ref: 'main' },
    requested_reviewers: [{ login: 'reviewer' }],
    html_url: 'https://github.com/acme/api/pull/11'
};

const COMMIT = {
    sha: 'abc1234def5678', html_url: 'https://github.com/acme/api/commit/abc1234',
    commit: { message: 'Add caching\n\nDetails', author: { name: 'Acme', date: '2026-08-01T00:00:00Z' }, tree: { sha: 't1' } },
    author: { login: 'acme' },
    stats: { additions: 40, deletions: 2, total: 42 },
    files: [{ filename: 'src/cache.js', status: 'modified', additions: 40, deletions: 2, patch: '@@ -1 +1 @@' }]
};

const JOB = {
    id: 5, name: 'build', conclusion: 'failure',
    html_url: 'https://github.com/acme/api/actions/jobs/5',
    steps: [{ name: 'npm test', conclusion: 'failure' }]
};

/** Namespaced responses, keyed exactly as the handlers call them. */
const RESPONSES = {
    'repos.get': { data: REPO },
    'repos.listBranches': { data: [{ name: 'main', protected: true, commit: { sha: 'abc1234def' } }] },
    'repos.listCommits': { data: [COMMIT] },
    'repos.getCommit': { data: COMMIT },
    'repos.compareCommitsWithBasehead': { data: { status: 'ahead', ahead_by: 3, behind_by: 0, commits: [COMMIT], files: COMMIT.files } },
    'repos.listTags': { data: [{ name: 'v1.0.0', commit: { sha: 'abc1234def' } }] },
    'repos.listCollaborators': { data: [{ login: 'acme', role_name: 'admin', permissions: { admin: true } }] },
    'repos.listLanguages': { data: { JavaScript: 9000, CSS: 1000 } },
    'repos.listContributors': { data: [{ login: 'acme', contributions: 40 }] },
    'repos.getViews': { data: { count: 100, uniques: 20 } },
    'repos.getClones': { data: { count: 10, uniques: 4 } },
    'repos.listReleases': { data: [{ tag_name: 'v1.0.0', name: 'First', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', html_url: 'u' }] },
    'repos.getLatestRelease': { data: { tag_name: 'v1.0.0', name: 'First', published_at: '2026-01-01T00:00:00Z', body: '## Changes\n- caching', html_url: 'u' } },
    'repos.listForUser': { data: [REPO] },
    // getContent answers with a directory listing or a file depending on the path,
    // exactly as GitHub does — the two callers read it very differently.
    'repos.getContent': (params) => (/\.\w+$/.test(params?.path || '')
        ? { data: { name: 'index.js', path: params.path, size: 24, sha: 'f1', content: Buffer.from('export default 1;\n').toString('base64') } }
        : { data: [{ name: 'index.js', path: 'src/index.js', type: 'file', size: 24 }, { name: 'lib', path: 'src/lib', type: 'dir', size: 0 }] }),
    'repos.getReadme': { data: { content: Buffer.from('# API\n\nIt serves things.').toString('base64') } },

    'git.getTree': { data: { tree: [{ path: 'src/index.js', type: 'blob' }, { path: 'src', type: 'tree' }], truncated: false } },

    'issues.listForRepo': { data: [ISSUE] },
    'issues.get': { data: ISSUE },
    'issues.listComments': { data: [{ user: { login: 'someone' }, created_at: '2026-08-02T00:00:00Z', body: 'Still broken.' }] },
    'issues.listLabelsForRepo': { data: [{ name: 'bug', color: 'd73a4a', description: 'A defect' }] },
    'issues.listMilestones': { data: [{ number: 1, title: 'v1', state: 'open', due_on: null, open_issues: 2, closed_issues: 5 }] },

    'pulls.list': { data: [PR] },
    'pulls.get': { data: PR },
    'pulls.listFiles': { data: COMMIT.files },
    'pulls.listReviews': { data: [{ user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-08-03T00:00:00Z', body: 'Looks good' }] },

    'actions.listRepoWorkflows': { data: { total_count: 1, workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] } },
    'actions.listWorkflowRunsForRepo': { data: { workflow_runs: [{ id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', event: 'push', head_sha: 'abc1234def', run_started_at: '2026-09-01T00:00:00Z', html_url: 'u' }] } },
    'actions.getWorkflowRun': { data: { id: 9, name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'abc1234def', event: 'push', html_url: 'u' } },
    'actions.listJobsForWorkflowRun': { data: { jobs: [JOB] } },
    'actions.downloadJobLogsForWorkflowRun': { data: 'setting up\nnpm test\nFAIL src/cache.test.js\nError: expected 1 to equal 2' },

    'users.getByUsername': { data: USER },
    'users.listFollowersForUser': { data: [{ login: 'fan1' }, { login: 'fan2' }] },
    'users.listFollowingForUser': { data: [{ login: 'idol' }] },

    'activity.listReposStarredByUser': { data: [REPO] },
    'orgs.listForUser': { data: [{ login: 'acme-org', description: 'An org' }] },
    'orgs.listMembers': { data: [{ login: 'acme' }] },

    'gists.listForUser': { data: [{ id: 'g1', description: 'notes', public: true, files: { 'a.md': {} }, updated_at: '2026-01-01T00:00:00Z', html_url: 'u' }] },

    'search.code': { data: { total_count: 1, items: [{ repository: REPO, path: 'src/cache.js', html_url: 'u' }] } },
    'search.issuesAndPullRequests': { data: { total_count: 1, items: [{ ...PR, repository_url: 'https://api.github.com/repos/acme/api' }] } },
    'search.users': { data: { total_count: 1, items: [{ login: 'acme', type: 'User', html_url: 'u' }] } },
    'search.repos': { data: { items: [REPO] } },

    'dependabot.listAlertsForRepo': { data: [] },
    'codeScanning.listAlertsForRepo': { data: [] },
    'rateLimit.get': { data: { resources: { core: { remaining: 4000, limit: 5000, reset: 1800000000 }, search: { remaining: 29, limit: 30 } } } },

    'apps.listReposAccessibleToInstallation': { data: { repositories: [REPO] } }
};

const called = new Set();

/** A client that answers what it knows and is loud about what it does not. */
function fakeClient() {
    const rest = new Proxy({}, {
        get: (_t, ns) => new Proxy({}, {
            get: (_t2, method) => async (params) => {
                const key = `${String(ns)}.${String(method)}`;
                called.add(key);
                if (!(key in RESPONSES)) {
                    const e = new Error(`The fake GitHub has no response for ${key}`);
                    e.status = 501;
                    throw e;
                }
                const canned = typeof RESPONSES[key] === 'function'
                    ? RESPONSES[key](params)
                    : RESPONSES[key];
                // A paged call must terminate: page 2 is always empty.
                if (params?.page > 1 && Array.isArray(canned.data)) return { data: [] };
                return canned;
            }
        })
    });
    return { rest, graphql: async () => ({}) };
}

databaseService.getInstallationForUser = async () => ({
    installationId: 1, login: 'acme', type: 'User', repositorySelection: 'all'
});
databaseService.listInstallationsForUser = async () => ([
    { installationId: 1, login: 'acme', type: 'User', repositorySelection: 'all' }
]);
githubService.getClient = async () => fakeClient();
clearRepoIndexCache();

// ── Run every read-only tool ────────────────────────────────────────────────

const ARGS = {
    repoName: 'acme/api',
    path: 'src/index.js',
    ref: 'main',
    sha: 'abc1234def',
    base: 'main',
    head: 'feat/cache',
    issueNumber: 7,
    prNumber: 11,
    runId: 9,
    query: 'caching',
    username: 'acme',
    org: 'acme-org',
    branch: 'main'
};

const registry = buildRegistry();

// Tools whose read path is a service with its own suite, or which need a network
// service the fake cannot stand in for. Each is covered elsewhere.
const COVERED_ELSEWHERE = new Set([
    'get_pull_request',        // pr.test.mjs
    'get_check_failures',      // pr.test.mjs
    'check_dependencies',      // hits the npm registry and OSV
    'check_repo_health',       // health.service, many endpoints
    'generate_changelog'       // advanced-workflows.service
]);

// These need a token that acts as the person, which this environment has none of.
// They are asserted on separately: the point is that they refuse usefully.
const NEEDS_USER_AUTH = new Set(['list_notifications']);

const readOnly = registry.list().filter(t =>
    !t.sideEffecting && !COVERED_ELSEWHERE.has(t.name) && !NEEDS_USER_AUTH.has(t.name));
check('there are read-only tools to exercise', readOnly.length > 20, readOnly.length);

const failures = [];
const mute = [];

for (const tool of readOnly) {
    const args = {};
    for (const name of Object.keys(tool.parameters.properties || {})) {
        if (ARGS[name] !== undefined) args[name] = ARGS[name];
    }

    const missing = (tool.parameters.required || []).filter(r => args[r] === undefined);
    if (missing.length) {
        failures.push(`${tool.name}: the smoke test has no value for ${missing.join(', ')}`);
        continue;
    }

    const result = await registry.execute(tool.name, args, { userId: 'u1' });

    if (!result.ok) {
        failures.push(`${tool.name}: ${result.error.code} — ${result.error.message}`);
        continue;
    }

    // A tool that returns nothing but the arguments it was given has not answered.
    const keys = Object.keys(result.data || {}).filter(k => k !== 'repository' && k !== 'username');
    if (keys.length === 0) {
        failures.push(`${tool.name}: returned no data beyond the target it was asked about`);
        continue;
    }

    // The narrator is what the user reads. A bare "Tool name — done" means the
    // result was not really described.
    const told = narrateResult(tool.name, args, result);
    if (/— done$/.test(told.summary)) mute.push(tool.name);
    if (typeof narrateStart(tool.name, args) !== 'string') {
        failures.push(`${tool.name}: narrateStart did not return a string`);
    }
}

check(`all ${readOnly.length} read-only tools return a real answer`, failures.length === 0, failures);

// Some generic narration is fine; most of the surface should say something specific.
check('at least four fifths of tools narrate their result specifically',
    mute.length <= readOnly.length / 5, mute);

// ── A tool that cannot act as the user says so, and says what to do ─────────
{
    // This is the failure mode that produced "I'm sorry, I cannot tell you how many
    // followers you have". A missing credential must come back as an instruction
    // the agent can relay, never as a vague inability.
    const refused = await registry.execute('list_notifications', {}, { userId: 'u1' });

    check('a user-scoped tool without a user token fails rather than pretending',
        refused.ok === false, refused);
    check('it names the reason as an authorization one',
        ['USER_AUTH_REQUIRED', 'USER_AUTH_UNCONFIGURED'].includes(refused.error?.code),
        refused.error?.code);
    check('it explains that the action must be done as the user',
        /as you|as your GitHub user/i.test(refused.error?.message || ''), refused.error?.message);
    check('it carries a hint saying what would fix it',
        (refused.error?.hint || '').length > 20, refused.error?.hint);

    // And the narration of that failure repeats the real reason, not "that failed".
    const told = narrateResult('list_notifications', {}, refused);
    check('the failure narration carries the real reason',
        told.summary === refused.error.message, told.summary);
    check('the failure is not narrated as a success', told.ok === false);
}

// ── The whole "glyph" path, through a real tool ─────────────────────────────
{
    // A user asked about a repository the installation could not see and was told
    // "it's possible the repository doesn't exist". End to end, through the
    // registry, that must now come back as a permissions answer with the visible
    // inventory attached.
    const notFound = new Error('Not Found');
    notFound.status = 404;

    const previousGetClient = githubService.getClient;
    githubService.getClient = async () => {
        const base = fakeClient();
        return {
            ...base,
            rest: new Proxy(base.rest, {
                get: (target, ns) => (ns === 'repos'
                    ? new Proxy(target[ns], {
                        get: (repoNs, method) => (method === 'get'
                            ? async () => { throw notFound; }
                            : repoNs[method])
                    })
                    : target[ns])
            })
        };
    };
    clearRepoIndexCache();

    const result = await registry.execute('list_pull_requests', { repoName: 'glyph' }, { userId: 'u1' });

    check('an unreachable repository is a failure, not an empty list', result.ok === false, result);
    check('it is reported as an access problem',
        result.error?.code === 'REPO_NOT_ACCESSIBLE', result.error?.code);
    check('the message does not conclude the repository is gone',
        /not visible to your installation/.test(result.error?.message || ''), result.error?.message);
    check('the hint survives all the way to the model',
        /settings\/installations/.test(result.error?.hint || ''), result.error?.hint);

    githubService.getClient = previousGetClient;
    clearRepoIndexCache();
}

// ── The fake was actually exercised ─────────────────────────────────────────
check('the tools reached a wide spread of GitHub endpoints', called.size >= 25, called.size);

report('tool smoke');
