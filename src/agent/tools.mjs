import { ToolRegistry } from './registry.mjs';
import { ok, fail } from '../providers/messages.mjs';
import { clientForRepo, resolveClient, parseRepo } from './github-access.mjs';
import githubService from '../services/github.service.mjs';
import advancedWorkflowsService from '../services/advanced-workflows.service.mjs';
import repoCreatorService from '../services/repo-creator.service.mjs';
import { sendEmail } from '../services/email.service.mjs';

/**
 * The agent's capabilities.
 *
 * Every tool here does what its description says. Tools that only produced an LLM
 * opinion dressed as a verified result (dependency "audits" recalled from training
 * data, health "scores" from a fixed template, conflict resolution that never read
 * a file) were removed rather than kept with softer wording. Real implementations
 * land with the PR tooling.
 */

const str = (description) => ({ type: 'string', description });

export function buildRegistry() {
    const registry = new ToolRegistry();

    // ── Reading ──────────────────────────────────────────────────────────────
    registry.register({
        name: 'list_repositories',
        description: 'Lists the repositories this user has granted access to, most recently pushed first. Use this when you need to know what the user has before acting.',
        parameters: { type: 'object', properties: {} },
        handler: async (_args, { userId }) => {
            const { client } = await resolveClient(userId);
            const repos = await githubService.listUserRepos(client);
            return ok({
                count: repos.length,
                repositories: repos
                    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
                    .map(r => ({ name: r.full_name, pushed_at: r.pushed_at, description: r.description }))
            });
        }
    });

    registry.register({
        name: 'get_readme',
        description: 'Fetches the README of a repository so you can understand what a project actually is before acting on it.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const readme = await githubService.getReadme(client, owner, repo);
            return ok({ repository: repoName, readme });
        }
    });

    registry.register({
        name: 'get_file',
        description: 'Reads a single file from a repository. Use this to inspect real code before proposing a change, rather than guessing at its contents.',
        parameters: {
            type: 'object',
            properties: {
                repoName: str('Full repository name, e.g. owner/repo'),
                path: str('File path within the repository, e.g. src/index.js')
            },
            required: ['repoName', 'path']
        },
        handler: async ({ repoName, path }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const content = await githubService.getFileContent(client, owner, repo, path);
            if (content === null) {
                return fail('NOT_FOUND', `"${path}" does not exist in ${repoName}, or it is a directory.`);
            }
            return ok({ repository: repoName, path, content });
        }
    });

    registry.register({
        name: 'search_repositories',
        description: 'Searches public GitHub repositories by topic, keyword, language or star count.',
        parameters: {
            type: 'object',
            properties: {
                topic: str('GitHub topic, e.g. machine-learning'),
                keyword: str('Free-text keyword'),
                language: str('Programming language filter'),
                minStars: { type: 'number', description: 'Minimum star count' },
                limit: { type: 'number', description: 'How many results to return (default 10)' }
            }
        },
        handler: async (args, { userId }) => {
            const { client } = await resolveClient(userId);
            const results = await githubService.searchRepositories(client, args);
            return ok({ count: results.length, results });
        }
    });

    // ── Pull requests ────────────────────────────────────────────────────────
    registry.register({
        name: 'list_pull_requests',
        description: 'Lists pull requests on a repository so you can decide which ones need attention.',
        parameters: {
            type: 'object',
            properties: {
                repoName: str('Full repository name, e.g. owner/repo'),
                state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Defaults to open' }
            },
            required: ['repoName']
        },
        handler: async ({ repoName, state = 'open' }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.pulls.list({ owner, repo, state, per_page: 30 });
            return ok({
                repository: repoName,
                count: data.length,
                pullRequests: data.map(pr => ({
                    number: pr.number,
                    title: pr.title,
                    author: pr.user?.login,
                    draft: pr.draft,
                    head: pr.head.ref,
                    base: pr.base.ref,
                    updated_at: pr.updated_at,
                    url: pr.html_url
                }))
            });
        }
    });

    registry.register({
        name: 'review_pull_request',
        description: 'Reads the real diff of a pull request and posts a review on GitHub.',
        parameters: {
            type: 'object',
            properties: {
                repoName: str('Full repository name, e.g. owner/repo'),
                prNumber: { type: 'number', description: 'Pull request number' }
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber }, { userId }) => {
            await clientForRepo(userId, repoName); // access check before acting
            const outcome = await advancedWorkflowsService.reviewPullRequest(repoName, prNumber);
            return ok({ repository: repoName, prNumber, outcome });
        }
    });

    // ── Writing ──────────────────────────────────────────────────────────────
    registry.register({
        name: 'push_file',
        description: 'Creates or replaces one file in a repository and commits it. Use for CI workflows, config files and other single-file changes.',
        parameters: {
            type: 'object',
            properties: {
                repoName: str('Full repository name, e.g. owner/repo'),
                path: str('File path including filename, e.g. .github/workflows/ci.yml'),
                content: str('The complete file content'),
                commitMessage: str('A descriptive commit message')
            },
            required: ['repoName', 'path', 'content', 'commitMessage']
        },
        handler: async ({ repoName, path, content, commitMessage }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            await githubService.pushFile(client, owner, repo, path, content, commitMessage);
            await logger?.info(`Pushed ${path} to ${repoName}`);
            return ok({ repository: repoName, path, commitMessage, committed: true });
        }
    });

    registry.register({
        name: 'create_repository',
        description: 'Scaffolds a brand new repository from a project description and pushes the generated files.',
        parameters: {
            type: 'object',
            properties: {
                name: str('Repository name (lowercase, hyphenated). Derived from the prompt if omitted.'),
                prompt: str('What the project should be'),
                techStack: str('e.g. Next.js + Tailwind, or Python FastAPI')
            },
            required: ['prompt', 'techStack']
        },
        handler: async ({ name, prompt, techStack }, { userId, logger }) => {
            const { client } = await resolveClient(userId);
            const { data: install } = await client.rest.apps.getAuthenticatedInstallation();
            const targetOwner = install.account.login;

            const repoName = (name || prompt)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 40);

            await logger?.info(`Creating ${targetOwner}/${repoName}`);
            const isOrg = install.account.type === 'Organization';
            const repo = await githubService.createRepository(client, repoName, prompt, isOrg ? targetOwner : null);

            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            const total = Object.keys(files).length;
            const pushed = [];
            for (const [path, content] of Object.entries(files)) {
                await githubService.pushFile(client, repo.owner.login, repo.name, path, content, 'Initial scaffold');
                pushed.push(path);
                await logger?.info(`Pushed ${path} (${pushed.length}/${total})`);
            }

            return ok({ repository: repo.full_name, url: repo.html_url, filesCreated: pushed });
        }
    });

    registry.register({
        name: 'fork_repository',
        description: 'Forks a public repository into the user account.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name to fork, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { owner, repo } = parseRepo(repoName);
            const { client } = await resolveClient(userId);
            const fork = await githubService.forkRepository(client, owner, repo);
            return ok({ forked: repoName, into: fork.full_name, url: fork.html_url });
        }
    });

    registry.register({
        name: 'star_repository',
        description: 'Stars a public repository.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { owner, repo } = parseRepo(repoName);
            const { client } = await resolveClient(userId);
            await githubService.starRepository(client, owner, repo);
            return ok({ starred: repoName });
        }
    });

    registry.register({
        name: 'build_feature',
        description: 'Opens a labelled issue that triggers the build pipeline: it analyses the repository, writes the change on a branch and opens a pull request. The work happens in the background.',
        parameters: {
            type: 'object',
            properties: {
                repoName: str('Full repository name, e.g. owner/repo'),
                featureDescription: str('A detailed description of what to build')
            },
            required: ['repoName', 'featureDescription']
        },
        handler: async ({ repoName, featureDescription }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const issue = await client.rest.issues.create({
                owner, repo,
                title: `Auto-Build: ${featureDescription.substring(0, 60)}`,
                body: `Requested via the Ulla Britta dashboard.\n\n${featureDescription}`,
                labels: ['ulla-build']
            });
            return ok({
                repository: repoName,
                issueNumber: issue.data.number,
                url: issue.data.html_url,
                status: 'queued',
                note: 'The build runs in the background and comments on this issue when the PR is ready, or explains why it stopped. It has not produced code yet.'
            });
        }
    });

    registry.register({
        name: 'generate_changelog',
        description: 'Generates a changelog from the last 20 commits on a repository.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            await clientForRepo(userId, repoName);
            const changelog = await advancedWorkflowsService.generateChangelog(repoName);
            return ok({ repository: repoName, changelog });
        }
    });

    registry.register({
        name: 'flag_stale_issues',
        description: 'Finds issues with no activity for over 30 days and posts a warning comment on each. Reports exactly how many were flagged.',
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            await clientForRepo(userId, repoName);
            const outcome = await advancedWorkflowsService.cleanStaleIssues(repoName);
            return ok({ repository: repoName, outcome });
        }
    });

    // ── Email ────────────────────────────────────────────────────────────────
    registry.register({
        name: 'send_email',
        description: 'Emails content to the user: a report, generated code, or a summary.',
        parameters: {
            type: 'object',
            properties: {
                subject: str('Subject line'),
                content: str('Markdown body')
            },
            required: ['subject', 'content']
        },
        handler: async ({ subject, content }, { userId }) => {
            await sendEmail(content, subject, userId);
            return ok({ sent: true, subject });
        }
    });

    // ── Destructive ──────────────────────────────────────────────────────────
    registry.register({
        name: 'delete_repository',
        description: 'PERMANENTLY deletes a repository. Irreversible. The system requires explicit user confirmation before this can run.',
        destructive: true,
        parameters: {
            type: 'object',
            properties: { repoName: str('Full repository name, e.g. owner/repo') },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            await githubService.deleteRepository(client, owner, repo);
            await logger?.warn(`Deleted repository ${repoName}`);
            return ok({ deleted: repoName });
        }
    });

    return registry;
}

export default buildRegistry;
