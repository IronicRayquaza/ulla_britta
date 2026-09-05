import { clientForRepo, resolveClient } from '../github-access.mjs';
import githubService from '../../services/github.service.mjs';
import { checkDependencies, formatDependencyReport } from '../../services/dependencies.service.mjs';
import { checkRepoHealth, formatHealthReport } from '../../services/health.service.mjs';
import { sendEmail } from '../../services/email.service.mjs';
import { ok, fail, str, num, enumOf, REPO, collect, clampLimit } from './common.mjs';

/**
 * Judgement about a repository rather than facts from it: dependency drift,
 * security advisories, overall health — plus discovery and the email channel.
 */
export default [
    {
        name: 'search_repositories',
        description: 'Searches public GitHub repositories by topic, keyword, language or star count. Use this to find projects, not to find the user\'s own — list_repositories does that.',
        parameters: {
            type: 'object',
            properties: {
                topic: str('GitHub topic, e.g. machine-learning'),
                keyword: str('Free-text keyword'),
                language: str('Programming language filter'),
                minStars: num('Minimum star count'),
                limit: num('How many results to return (default 10)')
            }
        },
        handler: async (args, { userId }) => {
            const { client } = await resolveClient(userId);
            const results = await githubService.searchRepositories(client, args);
            return ok({ count: results.length, results });
        }
    },

    {
        name: 'check_dependencies',
        description: 'Compares the package.json of a repository against the live npm registry and the OSV advisory database. Reports real version drift and real advisories, not recollection.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const content = await githubService.getFileContent(client, owner, repo, 'package.json');
            if (!content) {
                return fail('NOT_FOUND', `${owner}/${repo} has no package.json at its root.`);
            }
            const result = await checkDependencies(content);
            if (result.error) return fail('BAD_MANIFEST', result.error);
            return ok({
                repository: `${owner}/${repo}`,
                ...result,
                report: formatDependencyReport(`${owner}/${repo}`, result)
            });
        }
    },

    {
        name: 'check_repo_health',
        description: 'Measures repository health from real signals: CI pass rate, test setup, backlog age, commit recency. States which signals it could not read rather than scoring them as fine.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const health = await checkRepoHealth(client, owner, repo);
            return ok({ ...health, report: formatHealthReport(health) });
        }
    },

    {
        name: 'list_security_alerts',
        description: 'Reads a repository\'s open security alerts: Dependabot advisories on its dependencies and code-scanning findings. Says plainly when a feature is not enabled rather than reporting zero alerts as though it were clean.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                kind: enumOf(['dependabot', 'code-scanning', 'all'], 'Which alerts to read, default all'),
                severity: enumOf(['critical', 'high', 'medium', 'low'], 'Only alerts at or above this severity'),
                limit: num('How many of each kind to return (default 30)')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, kind = 'all', severity = null, limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const rank = { low: 0, medium: 1, moderate: 1, high: 2, critical: 3 };
            const atLeast = severity ? rank[severity] : -1;
            const result = { repository: `${owner}/${repo}` };
            const unavailable = [];

            if (kind === 'dependabot' || kind === 'all') {
                try {
                    const alerts = await collect(client, client.rest.dependabot.listAlertsForRepo,
                        { owner, repo, state: 'open' }, limit);
                    result.dependabot = alerts
                        .filter(a => (rank[a.security_advisory?.severity] ?? 0) >= atLeast)
                        .map(a => ({
                            package: a.dependency?.package?.name,
                            severity: a.security_advisory?.severity,
                            summary: a.security_advisory?.summary,
                            vulnerableRange: a.security_vulnerability?.vulnerable_version_range,
                            patchedIn: a.security_vulnerability?.first_patched_version?.identifier || null,
                            manifest: a.dependency?.manifest_path,
                            url: a.html_url
                        }));
                } catch (e) {
                    unavailable.push(e.status === 403 || e.status === 404
                        ? 'Dependabot alerts (not enabled on this repository, or the app lacks the Dependabot alerts permission)'
                        : `Dependabot alerts (${e.message})`);
                }
            }

            if (kind === 'code-scanning' || kind === 'all') {
                try {
                    const alerts = await collect(client, client.rest.codeScanning.listAlertsForRepo,
                        { owner, repo, state: 'open' }, limit);
                    result.codeScanning = alerts
                        .filter(a => (rank[a.rule?.security_severity_level || a.rule?.severity] ?? 0) >= atLeast)
                        .map(a => ({
                            rule: a.rule?.id,
                            severity: a.rule?.security_severity_level || a.rule?.severity,
                            description: a.rule?.description,
                            path: a.most_recent_instance?.location?.path,
                            line: a.most_recent_instance?.location?.start_line,
                            url: a.html_url
                        }));
                } catch (e) {
                    unavailable.push(e.status === 403 || e.status === 404
                        ? 'Code scanning alerts (not enabled on this repository, or the app lacks the Code scanning permission)'
                        : `Code scanning alerts (${e.message})`);
                }
            }

            const found = (result.dependabot?.length || 0) + (result.codeScanning?.length || 0);
            if (unavailable.length) result.couldNotRead = unavailable;
            result.totalOpen = found;

            // Zero alerts and "I could not look" are different answers. Say which.
            if (found === 0 && unavailable.length) {
                result.note = 'I found no alerts I could read, but some sources were unavailable — this is not a clean bill of health.';
            }

            return ok(result);
        }
    },

    {
        name: 'get_rate_limit',
        description: 'Reports how much GitHub API quota is left. Useful when calls start failing and you need to know whether it is a rate limit rather than a permission problem.',
        parameters: { type: 'object', properties: {} },
        handler: async (_args, { userId }) => {
            const { client } = await resolveClient(userId);
            const { data } = await client.rest.rateLimit.get();
            const core = data.resources.core;
            return ok({
                core: {
                    remaining: core.remaining,
                    limit: core.limit,
                    resetsAt: new Date(core.reset * 1000).toISOString()
                },
                search: {
                    remaining: data.resources.search.remaining,
                    limit: data.resources.search.limit
                }
            });
        }
    },

    {
        name: 'send_email',
        sideEffecting: true,
        description: 'Emails content to the user: a report, generated code, or a summary. Use this when they ask to be sent something, not as a substitute for answering here.',
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
    },

    {
        name: 'build_feature',
        sideEffecting: true,
        description: 'Opens a labelled issue that triggers the build pipeline: it analyses the repository, writes the change on a branch and opens a pull request. The work happens in the background.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
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
                repository: `${owner}/${repo}`,
                issueNumber: issue.data.number,
                url: issue.data.html_url,
                status: 'queued',
                note: 'The build runs in the background and comments on this issue when the PR is ready, or explains why it stopped. It has not produced code yet.'
            });
        }
    }
];
