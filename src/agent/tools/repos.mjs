import { clientForRepo, resolveClient, parseRepo, requireUserClient, preferUserClient } from '../github-access.mjs';
import githubService from '../../services/github.service.mjs';
import repoCreatorService from '../../services/repo-creator.service.mjs';
import { ok, fail, str, num, bool, arr, enumOf, REPO, repoSummary, collect, clampLimit } from './common.mjs';

/**
 * Repository lifecycle: what exists, what it is, creating it, changing its
 * settings, who can write to it, and destroying it.
 */
export default [
    {
        name: 'list_repositories',
        description: 'Lists the repositories this user has granted access to, most recently pushed first. Use this when you need to know what the user has before acting, or when a repository name they gave you does not resolve.',
        parameters: {
            type: 'object',
            properties: {
                limit: num('How many to return (default 30, max 100)'),
                sort: enumOf(['pushed', 'name', 'stars'], 'Ordering, default pushed')
            }
        },
        handler: async ({ limit, sort = 'pushed' }, { userId }) => {
            const { client, account } = await resolveClient(userId);
            const repos = await githubService.listUserRepos(client);

            const sorters = {
                pushed: (a, b) => new Date(b.pushed_at) - new Date(a.pushed_at),
                name: (a, b) => a.full_name.localeCompare(b.full_name),
                stars: (a, b) => (b.stars || 0) - (a.stars || 0)
            };

            return ok({
                account: account.login,
                repositorySelection: account.repositorySelection,
                total: repos.length,
                count: Math.min(repos.length, clampLimit(limit)),
                repositories: repos.sort(sorters[sort] || sorters.pushed).slice(0, clampLimit(limit))
                    .map(r => ({
                        name: r.full_name,
                        description: r.description,
                        private: r.private,
                        language: r.language,
                        pushed_at: r.pushed_at
                    }))
            });
        }
    },

    {
        name: 'get_repository',
        description: 'Reads a repository\'s facts: visibility, default branch, stars, forks, open issue count, topics, licence, size and when it was last pushed. Use this to answer questions about a repository rather than guessing from its name.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.repos.get({ owner, repo });
            return ok(repoSummary(data));
        }
    },

    {
        name: 'create_repository',
        sideEffecting: true,
        description: 'Creates an empty repository, optionally with a README, .gitignore and licence. This is the tool for "make me a new repo" — it writes no code. Use scaffold_repository instead when the user wants a working project generated.',
        parameters: {
            type: 'object',
            properties: {
                name: str('Repository name'),
                description: str('Short description shown on GitHub'),
                private: bool('Private repository (default false)'),
                owner: str('Organization to create it in. Defaults to the user\'s own account.'),
                autoInit: bool('Create an initial commit with a README (default true)'),
                readmeContent: str('Exact README.md content to commit. Implies autoInit.'),
                gitignoreTemplate: str('A .gitignore template name, e.g. Node, Python'),
                licenseTemplate: str('A licence keyword, e.g. mit, apache-2.0')
            },
            required: ['name']
        },
        handler: async (args, { userId, logger }) => {
            const {
                name, description = '', private: isPrivate = false, owner = null,
                autoInit = true, readmeContent = null, gitignoreTemplate = null, licenseTemplate = null
            } = args;

            const slug = String(name).trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
            if (!slug) return fail('BAD_ARGUMENTS', `"${name}" is not a usable repository name.`);

            const { account } = await resolveClient(userId);
            const targetOwner = owner || account.login;
            const isOrg = owner
                ? owner.toLowerCase() !== account.login.toLowerCase() || account.type === 'Organization'
                : account.type === 'Organization';

            // An organization repository can be created with the installation token.
            // A personal one cannot: POST /user/repos is user-to-server only, which is
            // why this used to fail even once the missing-method bug was out of the way.
            let client;
            if (isOrg) {
                ({ client } = await resolveClient(userId, `${targetOwner}/${slug}`));
            } else {
                ({ client } = await requireUserClient(userId, 'Creating a repository on your personal account'));
            }

            await logger?.info(`Creating ${targetOwner}/${slug}`);

            const repo = await githubService.createRepository(client, {
                name: slug,
                owner: targetOwner,
                description,
                isOrg,
                isPrivate,
                autoInit: autoInit || Boolean(readmeContent),
                gitignoreTemplate,
                licenseTemplate
            });

            const created = { repository: repo.full_name, url: repo.html_url, private: repo.private, files: [] };

            if (readmeContent) {
                await githubService.pushFile(
                    client, repo.owner.login, repo.name,
                    'README.md', readmeContent, 'Add README'
                );
                created.files.push('README.md');
                await logger?.info(`Wrote README.md to ${repo.full_name}`);
            }

            return ok(created);
        }
    },

    {
        name: 'scaffold_repository',
        sideEffecting: true,
        description: 'Creates a repository AND generates a starter project in it from a description and a tech stack. Use only when the user wants code written; for an empty repository use create_repository.',
        parameters: {
            type: 'object',
            properties: {
                name: str('Repository name (lowercase, hyphenated). Derived from the prompt if omitted.'),
                prompt: str('What the project should be'),
                techStack: str('e.g. Next.js + Tailwind, or Python FastAPI'),
                private: bool('Private repository (default false)'),
                owner: str('Organization to create it in. Defaults to the user\'s own account.')
            },
            required: ['prompt', 'techStack']
        },
        handler: async ({ name, prompt, techStack, private: isPrivate = false, owner = null }, { userId, logger }) => {
            const { account } = await resolveClient(userId);
            const targetOwner = owner || account.login;
            const isOrg = owner
                ? owner.toLowerCase() !== account.login.toLowerCase() || account.type === 'Organization'
                : account.type === 'Organization';

            const repoName = (name || prompt)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 40);

            const { client } = isOrg
                ? await resolveClient(userId, `${targetOwner}/${repoName}`)
                : await requireUserClient(userId, 'Creating a repository on your personal account');

            await logger?.info(`Creating ${targetOwner}/${repoName}`);
            const repo = await githubService.createRepository(client, {
                name: repoName, owner: targetOwner, description: prompt, isOrg, isPrivate, autoInit: true
            });

            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
            if (!entries.length) {
                return ok({
                    repository: repo.full_name,
                    url: repo.html_url,
                    filesCreated: [],
                    note: 'The repository was created but the scaffolder returned no files.'
                });
            }

            // One commit rather than one per file, so the repository is never observed
            // half-scaffolded.
            const commit = await githubService.pushFiles(
                client, repo.owner.login, repo.name, entries, 'Initial scaffold'
            );
            await logger?.info(`Pushed ${entries.length} file(s) to ${repo.full_name}`);

            return ok({
                repository: repo.full_name,
                url: repo.html_url,
                filesCreated: commit.files,
                commit: commit.sha
            });
        }
    },

    {
        name: 'update_repository',
        sideEffecting: true,
        description: 'Changes a repository\'s settings: description, homepage, default branch, visibility, whether issues/wiki/projects are enabled, and whether it is archived.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                description: str('New description'),
                homepage: str('Project website URL'),
                defaultBranch: str('New default branch (it must already exist)'),
                private: bool('Make the repository private or public'),
                hasIssues: bool('Enable or disable the issue tracker'),
                hasWiki: bool('Enable or disable the wiki'),
                hasProjects: bool('Enable or disable projects'),
                archived: bool('Archive the repository (read-only). Unarchiving is not possible through the API.')
            },
            required: ['repoName']
        },
        handler: async (args, { userId, logger }) => {
            const { repoName, ...changes } = args;
            const { client, owner, repo } = await clientForRepo(userId, repoName);

            const payload = {
                ...(changes.description !== undefined && { description: changes.description }),
                ...(changes.homepage !== undefined && { homepage: changes.homepage }),
                ...(changes.defaultBranch !== undefined && { default_branch: changes.defaultBranch }),
                ...(changes.private !== undefined && { private: changes.private }),
                ...(changes.hasIssues !== undefined && { has_issues: changes.hasIssues }),
                ...(changes.hasWiki !== undefined && { has_wiki: changes.hasWiki }),
                ...(changes.hasProjects !== undefined && { has_projects: changes.hasProjects }),
                ...(changes.archived !== undefined && { archived: changes.archived })
            };

            if (!Object.keys(payload).length) {
                return fail('BAD_ARGUMENTS', 'Nothing to change — pass at least one setting.');
            }

            const { data } = await client.rest.repos.update({ owner, repo, ...payload });
            await logger?.info(`Updated ${owner}/${repo}: ${Object.keys(payload).join(', ')}`);
            return ok({ repository: data.full_name, changed: Object.keys(payload), ...repoSummary(data) });
        }
    },

    {
        name: 'set_repository_topics',
        sideEffecting: true,
        description: 'Replaces a repository\'s topics with the list given. Topics are how a repository is found on GitHub.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                topics: arr('The complete set of topics, lowercase and hyphenated')
            },
            required: ['repoName', 'topics']
        },
        handler: async ({ repoName, topics }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const clean = (topics || []).map(t => String(t).toLowerCase().replace(/[^a-z0-9-]/g, '-')).filter(Boolean);
            const { data } = await client.rest.repos.replaceAllTopics({ owner, repo, names: clean });
            return ok({ repository: `${owner}/${repo}`, topics: data.names });
        }
    },

    {
        name: 'fork_repository',
        sideEffecting: true,
        description: 'Forks a repository into the user\'s account or an organization.',
        parameters: {
            type: 'object',
            properties: {
                repoName: str('Full repository name to fork, e.g. owner/repo'),
                organization: str('Fork into this organization instead of the personal account')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, organization = null }, { userId }) => {
            // The whole point of forking is that the source is usually somebody
            // else's repository, so the name is parsed rather than resolved against
            // this user's installations — which would refuse every public repo.
            const { owner, repo, qualified } = parseRepo(repoName);
            if (!qualified) {
                return fail('BAD_REPO_NAME', `Forking needs the full "owner/repo" name, and "${repoName}" has no owner.`);
            }

            const { client } = await preferUserClient(userId);
            const { data } = await client.rest.repos.createFork({
                owner, repo, ...(organization && { organization })
            });
            return ok({ forked: `${owner}/${repo}`, into: data.full_name, url: data.html_url });
        }
    },

    {
        name: 'star_repository',
        sideEffecting: true,
        description: 'Stars a repository as the user. Requires the user to have connected their GitHub account.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { owner, repo, qualified } = parseRepo(repoName);
            if (!qualified) {
                return fail('BAD_REPO_NAME', `Starring needs the full "owner/repo" name, and "${repoName}" has no owner.`);
            }
            // Starring is an act of the person, not the app: an installation token is
            // refused here, which is why this silently failed before.
            const { client, login } = await requireUserClient(userId, 'Starring a repository');
            await client.rest.activity.starRepoForAuthenticatedUser({ owner, repo });
            return ok({ starred: `${owner}/${repo}`, as: login });
        }
    },

    {
        name: 'unstar_repository',
        sideEffecting: true,
        description: 'Removes the user\'s star from a repository.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { owner, repo, qualified } = parseRepo(repoName);
            if (!qualified) {
                return fail('BAD_REPO_NAME', `Unstarring needs the full "owner/repo" name, and "${repoName}" has no owner.`);
            }
            const { client, login } = await requireUserClient(userId, 'Unstarring a repository');
            await client.rest.activity.unstarRepoForAuthenticatedUser({ owner, repo });
            return ok({ unstarred: `${owner}/${repo}`, as: login });
        }
    },

    {
        name: 'list_collaborators',
        description: 'Lists who has access to a repository and at what permission level.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, limit: num('How many to return') },
            required: ['repoName']
        },
        handler: async ({ repoName, limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const people = await collect(client, client.rest.repos.listCollaborators, { owner, repo }, limit);
            return ok({
                repository: `${owner}/${repo}`,
                count: people.length,
                collaborators: people.map(p => ({
                    login: p.login,
                    permission: p.role_name || (p.permissions?.admin ? 'admin' : p.permissions?.push ? 'write' : 'read')
                }))
            });
        }
    },

    {
        name: 'add_collaborator',
        sideEffecting: true,
        description: 'Invites someone to a repository at a given permission level. They receive an invitation they must accept.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                username: str('GitHub username to invite'),
                permission: enumOf(['pull', 'triage', 'push', 'maintain', 'admin'], 'Access level, default push')
            },
            required: ['repoName', 'username']
        },
        handler: async ({ repoName, username, permission = 'push' }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.repos.addCollaborator({ owner, repo, username, permission });
            await logger?.info(`Invited ${username} to ${owner}/${repo} as ${permission}`);
            // GitHub returns 204 with no body when the user already had access.
            return ok({
                repository: `${owner}/${repo}`,
                username,
                permission,
                invited: Boolean(data?.id),
                note: data?.id ? 'An invitation was sent and is pending acceptance.' : 'They already had access; nothing changed.'
            });
        }
    },

    {
        name: 'remove_collaborator',
        sideEffecting: true,
        description: 'Removes someone\'s access to a repository.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, username: str('GitHub username to remove') },
            required: ['repoName', 'username']
        },
        handler: async ({ repoName, username }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            await client.rest.repos.removeCollaborator({ owner, repo, username });
            await logger?.warn(`Removed ${username} from ${owner}/${repo}`);
            return ok({ repository: `${owner}/${repo}`, removed: username });
        }
    },

    {
        name: 'get_repository_stats',
        description: 'Reads a repository\'s language breakdown, top contributors and — where the app has permission — page views and clones. Reports which parts it could not read rather than leaving them out.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);

            const [languages, contributors, views, clones] = await Promise.allSettled([
                client.rest.repos.listLanguages({ owner, repo }),
                client.rest.repos.listContributors({ owner, repo, per_page: 10 }),
                client.rest.repos.getViews({ owner, repo }),
                client.rest.repos.getClones({ owner, repo })
            ]);

            const unreadable = [];
            const result = { repository: `${owner}/${repo}` };

            if (languages.status === 'fulfilled') {
                const bytes = languages.value.data;
                const total = Object.values(bytes).reduce((a, b) => a + b, 0) || 1;
                result.languages = Object.entries(bytes)
                    .map(([name, n]) => ({ name, percent: Math.round((n / total) * 1000) / 10 }))
                    .sort((a, b) => b.percent - a.percent);
            } else unreadable.push('languages');

            if (contributors.status === 'fulfilled') {
                result.contributors = contributors.value.data.map(c => ({ login: c.login, commits: c.contributions }));
            } else unreadable.push('contributors');

            if (views.status === 'fulfilled') {
                result.views14d = { total: views.value.data.count, unique: views.value.data.uniques };
            } else unreadable.push('traffic views (needs admin access)');

            if (clones.status === 'fulfilled') {
                result.clones14d = { total: clones.value.data.count, unique: clones.value.data.uniques };
            } else unreadable.push('clone counts (needs admin access)');

            if (unreadable.length) result.couldNotRead = unreadable;
            return ok(result);
        }
    },

    {
        name: 'delete_repository',
        description: 'PERMANENTLY deletes a repository. Irreversible. The system requires explicit user confirmation before this can run.',
        destructive: true,
        sideEffecting: true,
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            await githubService.deleteRepository(client, owner, repo);
            await logger?.warn(`Deleted repository ${owner}/${repo}`);
            return ok({ deleted: `${owner}/${repo}` });
        }
    }
];
