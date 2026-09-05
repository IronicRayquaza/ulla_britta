import { clientForRepo, resolveClient } from '../github-access.mjs';
import githubService from '../../services/github.service.mjs';
import { ok, fail, str, num, arr, REPO, excerpt, collect, clampLimit } from './common.mjs';

/**
 * File contents: reading a repository's tree, and writing to it.
 */
export default [
    {
        name: 'get_readme',
        description: 'Fetches the README of a repository so you can understand what a project actually is before acting on it.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const readme = await githubService.getReadme(client, owner, repo);
            return ok({ repository: `${owner}/${repo}`, readme: excerpt(readme, 8000) });
        }
    },

    {
        name: 'get_file',
        description: 'Reads a single file from a repository. Use this to inspect real code before proposing a change, rather than guessing at its contents.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                path: str('File path within the repository, e.g. src/index.js'),
                ref: str('Branch, tag or commit SHA. Defaults to the default branch.')
            },
            required: ['repoName', 'path']
        },
        handler: async ({ repoName, path, ref = null }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const { data } = await client.rest.repos.getContent({
                    owner, repo, path, ...(ref && { ref })
                });
                if (Array.isArray(data)) {
                    return fail('IS_DIRECTORY', `"${path}" is a directory. Use list_directory to see what is in it.`);
                }
                if (!data.content) {
                    return fail('NOT_READABLE', `"${path}" has no inline content — it is probably too large or binary.`);
                }
                return ok({
                    repository: `${owner}/${repo}`,
                    path,
                    ref: ref || 'default branch',
                    size: data.size,
                    content: excerpt(Buffer.from(data.content, 'base64').toString('utf8'), 12000)
                });
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `"${path}" does not exist in ${owner}/${repo}${ref ? ` at ${ref}` : ''}.`, {
                        hint: 'Call list_directory on the parent path to see what is actually there.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'list_directory',
        description: 'Lists the files and folders at a path in a repository. Use this to explore a project you have not read before, instead of guessing at file paths.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                path: str('Directory path. Empty or omitted for the repository root.'),
                ref: str('Branch, tag or commit SHA')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, path = '', ref = null }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const entries = await githubService.listDirectory(client, owner, repo, path, ref);
                return ok({
                    repository: `${owner}/${repo}`,
                    path: path || '/',
                    count: entries.length,
                    entries
                });
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `There is no path "${path || '/'}" in ${owner}/${repo}.`);
                }
                throw e;
            }
        }
    },

    {
        name: 'get_repository_tree',
        description: 'Lists every file path in a repository in one call. Use this when you need the shape of a whole project rather than one directory at a time.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                ref: str('Branch, tag or commit SHA. Defaults to the default branch.'),
                limit: num('Maximum paths to return (default 300)')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, ref = null, limit = 300 }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data: repoData } = await client.rest.repos.get({ owner, repo });
            const treeRef = ref || repoData.default_branch;

            const { data } = await client.rest.git.getTree({
                owner, repo, tree_sha: treeRef, recursive: 'true'
            });

            const files = data.tree.filter(t => t.type === 'blob');
            const cap = Math.min(1000, Math.max(1, Number(limit) || 300));

            return ok({
                repository: `${owner}/${repo}`,
                ref: treeRef,
                totalFiles: files.length,
                // GitHub itself truncates very large trees; say so rather than
                // presenting a partial listing as the whole project.
                truncatedByGitHub: data.truncated,
                paths: files.slice(0, cap).map(f => f.path),
                ...(files.length > cap && { note: `Showing ${cap} of ${files.length} paths.` })
            });
        }
    },

    {
        name: 'push_file',
        sideEffecting: true,
        description: 'Creates or replaces one file in a repository and commits it. Use for CI workflows, config files and other single-file changes.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                path: str('File path including filename, e.g. .github/workflows/ci.yml'),
                content: str('The complete file content'),
                commitMessage: str('A descriptive commit message'),
                branch: str('Branch to commit to. Defaults to the default branch.')
            },
            required: ['repoName', 'path', 'content', 'commitMessage']
        },
        handler: async ({ repoName, path, content, commitMessage, branch = null }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            if (branch) {
                await githubService.createOrUpdateFile(client, owner, repo, path, commitMessage, content, branch);
            } else {
                await githubService.pushFile(client, owner, repo, path, content, commitMessage);
            }
            await logger?.info(`Pushed ${path} to ${owner}/${repo}${branch ? ` on ${branch}` : ''}`);
            return ok({ repository: `${owner}/${repo}`, path, branch: branch || 'default', commitMessage, committed: true });
        }
    },

    {
        name: 'push_files',
        sideEffecting: true,
        description: 'Writes several files in ONE commit. Use this instead of calling push_file repeatedly, so a multi-file change lands atomically rather than as a half-applied series of commits.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                files: arr('The files to write', {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        content: { type: 'string', description: 'Complete file content' }
                    },
                    required: ['path', 'content']
                }),
                commitMessage: str('A descriptive commit message'),
                branch: str('Branch to commit to. Defaults to the default branch.')
            },
            required: ['repoName', 'files', 'commitMessage']
        },
        handler: async ({ repoName, files, commitMessage, branch = null }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const valid = (files || []).filter(f => f?.path && typeof f.content === 'string');
            if (!valid.length) {
                return fail('BAD_ARGUMENTS', 'No files with both a path and content were given.');
            }
            const commit = await githubService.pushFiles(client, owner, repo, valid, commitMessage, branch);
            await logger?.info(`Committed ${valid.length} file(s) to ${owner}/${repo} as ${commit.sha.slice(0, 7)}`);
            return ok({ repository: `${owner}/${repo}`, ...commit });
        }
    },

    {
        name: 'delete_file',
        sideEffecting: true,
        description: 'Deletes one file from a repository and commits the removal.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                path: str('File path to delete'),
                commitMessage: str('A descriptive commit message'),
                branch: str('Branch to commit to. Defaults to the default branch.')
            },
            required: ['repoName', 'path', 'commitMessage']
        },
        handler: async ({ repoName, path, commitMessage, branch = null }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                await githubService.deleteFile(client, owner, repo, path, commitMessage, branch);
            } catch (e) {
                if (e.status === 404) return fail('NOT_FOUND', `"${path}" does not exist in ${owner}/${repo}.`);
                throw e;
            }
            await logger?.warn(`Deleted ${path} from ${owner}/${repo}`);
            return ok({ repository: `${owner}/${repo}`, path, deleted: true });
        }
    },

    {
        name: 'search_code',
        description: 'Searches file contents across repositories for a string or symbol. Use this to find where something is defined or used, instead of opening files one at a time.',
        parameters: {
            type: 'object',
            properties: {
                query: str('What to search for, e.g. "createClient" or "TODO"'),
                repoName: str('Restrict to one repository, "owner/repo"'),
                language: str('Restrict to a language, e.g. typescript'),
                path: str('Restrict to a path prefix, e.g. src/'),
                filename: str('Restrict to files with this name, e.g. package.json'),
                limit: num('How many results to return (default 20)')
            },
            required: ['query']
        },
        handler: async ({ query, repoName, language, path, filename, limit = 20 }, { userId }) => {
            // Search is global and reads public code, so the client is resolved from
            // the user rather than scoped to the repository being filtered on —
            // scoping it would refuse a search across someone else's public code.
            const { client } = await resolveClient(userId);
            const parts = [query];
            if (repoName) parts.push(`repo:${repoName}`);
            if (language) parts.push(`language:${language}`);
            if (path) parts.push(`path:${path}`);
            if (filename) parts.push(`filename:${filename}`);

            try {
                const { data } = await client.rest.search.code({
                    q: parts.join(' '),
                    per_page: clampLimit(limit, 20)
                });
                return ok({
                    query: parts.join(' '),
                    total: data.total_count,
                    count: data.items.length,
                    results: data.items.map(i => ({
                        repository: i.repository.full_name,
                        path: i.path,
                        url: i.html_url
                    }))
                });
            } catch (e) {
                if (e.status === 422) {
                    return fail('BAD_QUERY', `GitHub rejected that code search: ${e.message}`, {
                        hint: 'Code search needs at least one search term and cannot use wildcards.'
                    });
                }
                throw e;
            }
        }
    }
];
