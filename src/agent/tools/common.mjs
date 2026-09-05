import { ok, fail } from '../../providers/messages.mjs';

/**
 * Shared building blocks for tool definitions.
 *
 * The tool surface used to be one 456-line file whose descriptions drifted from
 * what the handlers did. It is now split by GitHub domain — repositories, files,
 * git history, issues, pull requests, Actions, releases, users, security — with the
 * schema helpers here so every tool describes its arguments the same way.
 */

export { ok, fail };

export const str = (description) => ({ type: 'string', description });
export const num = (description) => ({ type: 'number', description });
export const bool = (description) => ({ type: 'boolean', description });
export const enumOf = (values, description) => ({ type: 'string', enum: values, description });
export const arr = (description, items = { type: 'string' }) => ({ type: 'array', items, description });

/** Every repository-scoped tool takes the same first argument. */
export const REPO = str('Repository name. "owner/repo", or just the repository name if it is one of the user\'s own.');

/**
 * How many list items a tool returns by default.
 *
 * Tool results go into the model's context verbatim, so an unbounded listing is a
 * real cost. Callers can raise it when they need to.
 */
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export const clampLimit = (n, fallback = DEFAULT_LIMIT) =>
    Math.min(MAX_LIMIT, Math.max(1, Number(n) || fallback));

/** Trims a body to something worth putting in context, and says when it did. */
export function excerpt(text, max = 4000) {
    if (typeof text !== 'string') return text;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n\n…[truncated, ${text.length - max} more characters]`;
}

/** GitHub's user objects are large; the agent needs a handful of fields. */
export const actor = (u) => (u ? { login: u.login, type: u.type } : null);

export const label = (l) => (typeof l === 'string' ? l : l?.name);

/** The shape the agent reasons about for an issue or a pull request. */
export function issueSummary(issue) {
    return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        isPullRequest: Boolean(issue.pull_request),
        author: issue.user?.login,
        labels: (issue.labels || []).map(label),
        assignees: (issue.assignees || []).map(a => a.login),
        comments: issue.comments,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        url: issue.html_url
    };
}

export function repoSummary(r) {
    return {
        name: r.full_name,
        description: r.description,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
        default_branch: r.default_branch,
        language: r.language,
        stars: r.stargazers_count ?? r.stars,
        forks: r.forks_count,
        open_issues: r.open_issues_count ?? r.open_issues,
        topics: r.topics,
        license: r.license?.spdx_id || null,
        pushed_at: r.pushed_at,
        url: r.html_url
    };
}

export function commitSummary(c) {
    return {
        sha: c.sha?.slice(0, 7),
        full_sha: c.sha,
        message: c.commit?.message?.split('\n')[0],
        author: c.commit?.author?.name || c.author?.login,
        date: c.commit?.author?.date,
        url: c.html_url
    };
}

/**
 * Pages through an Octokit list endpoint up to `limit` items.
 * Octokit's paginate would fetch everything; a repository with 4,000 issues would
 * then be loaded in full to show the agent thirty of them.
 */
export async function collect(client, endpoint, params, limit) {
    const want = clampLimit(limit);
    const out = [];
    let page = 1;

    while (out.length < want && page <= 10) {
        const { data } = await endpoint({ ...params, per_page: Math.min(100, want - out.length), page });
        const items = Array.isArray(data) ? data : (data.items || data.workflows || data.workflow_runs || []);
        out.push(...items);
        if (items.length < Math.min(100, want - out.length)) break;
        page++;
    }

    return out.slice(0, want);
}

/**
 * Registers a batch of tool definitions.
 * Each module exports an array; index.mjs feeds them all through here.
 */
export function registerAll(registry, tools) {
    for (const tool of tools) registry.register(tool);
    return registry;
}
