import { clientForRepo } from '../github-access.mjs';
import githubService from '../../services/github.service.mjs';
import advancedWorkflowsService from '../../services/advanced-workflows.service.mjs';
import { ok, fail, str, num, bool, REPO, commitSummary, collect, clampLimit } from './common.mjs';

/**
 * Branches, commits, tags and history — the git-level view of a repository.
 */
export default [
    {
        name: 'list_branches',
        description: 'Lists the branches of a repository, marking the default one and which are protected.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, limit: num('How many to return') },
            required: ['repoName']
        },
        handler: async ({ repoName, limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const [{ data: meta }, branches] = await Promise.all([
                client.rest.repos.get({ owner, repo }),
                collect(client, client.rest.repos.listBranches, { owner, repo }, limit)
            ]);
            return ok({
                repository: `${owner}/${repo}`,
                defaultBranch: meta.default_branch,
                count: branches.length,
                branches: branches.map(b => ({
                    name: b.name,
                    protected: b.protected,
                    sha: b.commit.sha.slice(0, 7),
                    isDefault: b.name === meta.default_branch
                }))
            });
        }
    },

    {
        name: 'create_branch',
        sideEffecting: true,
        description: 'Creates a branch from another branch or commit. Use this before making a set of changes you intend to open a pull request for.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                branch: str('New branch name'),
                from: str('Branch or SHA to branch from. Defaults to the default branch.')
            },
            required: ['repoName', 'branch']
        },
        handler: async ({ repoName, branch, from = null }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data: meta } = await client.rest.repos.get({ owner, repo });
            const base = from || meta.default_branch;

            try {
                await githubService.createBranch(client, owner, repo, branch, base);
            } catch (e) {
                if (e.status === 422) {
                    return fail('ALREADY_EXISTS', `The branch "${branch}" already exists in ${owner}/${repo}.`);
                }
                throw e;
            }
            await logger?.info(`Created branch ${branch} from ${base} in ${owner}/${repo}`);
            return ok({ repository: `${owner}/${repo}`, branch, from: base, created: true });
        }
    },

    {
        name: 'delete_branch',
        sideEffecting: true,
        description: 'Deletes a branch. Refuses to delete the default branch.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, branch: str('Branch to delete') },
            required: ['repoName', 'branch']
        },
        handler: async ({ repoName, branch }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data: meta } = await client.rest.repos.get({ owner, repo });

            if (branch === meta.default_branch) {
                return fail('REFUSED', `"${branch}" is the default branch of ${owner}/${repo}. I will not delete it.`);
            }

            try {
                await client.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
            } catch (e) {
                if (e.status === 422 || e.status === 404) {
                    return fail('NOT_FOUND', `There is no branch "${branch}" in ${owner}/${repo}.`);
                }
                throw e;
            }
            await logger?.warn(`Deleted branch ${branch} from ${owner}/${repo}`);
            return ok({ repository: `${owner}/${repo}`, branch, deleted: true });
        }
    },

    {
        name: 'list_commits',
        description: 'Lists recent commits, optionally filtered by branch, file path, author or date. Use this to see what has actually been happening in a repository.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                branch: str('Branch or SHA to read history from'),
                path: str('Only commits that touched this file or directory'),
                author: str('Only commits by this GitHub username or email'),
                since: str('ISO date — only commits after it'),
                until: str('ISO date — only commits before it'),
                limit: num('How many to return (default 30)')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, branch, path, author, since, until, limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const commits = await collect(client, client.rest.repos.listCommits, {
                owner, repo,
                ...(branch && { sha: branch }),
                ...(path && { path }),
                ...(author && { author }),
                ...(since && { since }),
                ...(until && { until })
            }, limit);

            return ok({
                repository: `${owner}/${repo}`,
                count: commits.length,
                commits: commits.map(commitSummary)
            });
        }
    },

    {
        name: 'get_commit',
        description: 'Reads one commit in full: its message, its stats, and which files it changed with their diffs.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                sha: str('Commit SHA, or a branch name for its head commit'),
                includePatches: bool('Include the actual diff text (default false — it is large)')
            },
            required: ['repoName', 'sha']
        },
        handler: async ({ repoName, sha, includePatches = false }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.repos.getCommit({ owner, repo, ref: sha });

            return ok({
                repository: `${owner}/${repo}`,
                ...commitSummary(data),
                fullMessage: data.commit.message,
                stats: data.stats,
                files: (data.files || []).map(f => ({
                    path: f.filename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    ...(includePatches && f.patch && { patch: f.patch.slice(0, 3000) })
                }))
            });
        }
    },

    {
        name: 'compare_branches',
        description: 'Compares two branches, tags or commits: how far ahead or behind, which commits differ and which files changed. Use this to answer "what is on this branch that is not on main".',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                base: str('The branch or SHA to compare against, e.g. main'),
                head: str('The branch or SHA being compared')
            },
            required: ['repoName', 'base', 'head']
        },
        handler: async ({ repoName, base, head }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const { data } = await client.rest.repos.compareCommitsWithBasehead({
                    owner, repo, basehead: `${base}...${head}`
                });
                return ok({
                    repository: `${owner}/${repo}`,
                    base, head,
                    status: data.status,
                    aheadBy: data.ahead_by,
                    behindBy: data.behind_by,
                    commits: data.commits.slice(-20).map(commitSummary),
                    files: (data.files || []).slice(0, 40).map(f => ({
                        path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions
                    }))
                });
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `Could not compare ${base}...${head} in ${owner}/${repo} — one of those refs does not exist.`);
                }
                throw e;
            }
        }
    },

    {
        name: 'list_tags',
        description: 'Lists a repository\'s git tags, newest first.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, limit: num('How many to return') },
            required: ['repoName']
        },
        handler: async ({ repoName, limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const tags = await collect(client, client.rest.repos.listTags, { owner, repo }, limit);
            return ok({
                repository: `${owner}/${repo}`,
                count: tags.length,
                tags: tags.map(t => ({ name: t.name, sha: t.commit.sha.slice(0, 7) }))
            });
        }
    },

    {
        name: 'generate_changelog',
        description: 'Generates a changelog from the recent commits on a repository.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const result = await advancedWorkflowsService.generateChangelog(client, owner, repo);
            return ok({ repository: `${owner}/${repo}`, ...result });
        }
    }
];
