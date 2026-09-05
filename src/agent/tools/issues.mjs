import { clientForRepo, resolveClient } from '../github-access.mjs';
import githubService from '../../services/github.service.mjs';
import advancedWorkflowsService from '../../services/advanced-workflows.service.mjs';
import { ok, fail, str, num, bool, arr, enumOf, REPO, issueSummary, excerpt, collect, clampLimit } from './common.mjs';

/**
 * Issues, comments, labels and milestones — the tracker side of GitHub.
 *
 * GitHub models pull requests as issues, so comment_on_issue, labels, assignees
 * and milestones all work on a PR number too. The descriptions say so, because an
 * agent that does not know this asks for a tool that does not need to exist.
 */
export default [
    {
        name: 'list_issues',
        description: 'Lists issues on a repository, filtered by state, label, assignee or age. Pull requests are excluded — use list_pull_requests for those.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                state: enumOf(['open', 'closed', 'all'], 'Defaults to open'),
                labels: str('Comma-separated label names to filter by'),
                assignee: str('GitHub username, or "none" for unassigned'),
                creator: str('Only issues opened by this username'),
                since: str('ISO date — only issues updated after it'),
                sort: enumOf(['created', 'updated', 'comments'], 'Ordering, default created'),
                limit: num('How many to return (default 30)')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, state = 'open', labels, assignee, creator, since, sort = 'created', limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const items = await collect(client, client.rest.issues.listForRepo, {
                owner, repo, state, sort, direction: 'desc',
                ...(labels && { labels }),
                ...(assignee && { assignee }),
                ...(creator && { creator }),
                ...(since && { since })
            }, limit);

            // listForRepo returns pull requests too; the caller asked for issues.
            const issues = items.filter(i => !i.pull_request);
            return ok({
                repository: `${owner}/${repo}`,
                state,
                count: issues.length,
                issues: issues.map(issueSummary)
            });
        }
    },

    {
        name: 'get_issue',
        description: 'Reads one issue in full, including its body and its most recent comments. Works for pull requests too.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                issueNumber: num('Issue or pull request number'),
                includeComments: bool('Include the discussion (default true)')
            },
            required: ['repoName', 'issueNumber']
        },
        handler: async ({ repoName, issueNumber, includeComments = true }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const { data } = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
                const result = {
                    repository: `${owner}/${repo}`,
                    ...issueSummary(data),
                    body: excerpt(data.body || '', 6000),
                    milestone: data.milestone?.title || null,
                    closed_at: data.closed_at
                };

                if (includeComments && data.comments > 0) {
                    const comments = await collect(client, client.rest.issues.listComments,
                        { owner, repo, issue_number: issueNumber }, 20);
                    result.discussion = comments.map(c => ({
                        author: c.user?.login,
                        at: c.created_at,
                        body: excerpt(c.body || '', 1500)
                    }));
                }
                return ok(result);
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `There is no issue #${issueNumber} in ${owner}/${repo}.`);
                }
                throw e;
            }
        }
    },

    {
        name: 'create_issue',
        sideEffecting: true,
        description: 'Opens an issue on a repository, optionally with labels, assignees and a milestone.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                title: str('Issue title'),
                body: str('Issue body, in Markdown'),
                labels: arr('Label names to apply'),
                assignees: arr('GitHub usernames to assign'),
                milestone: num('Milestone number')
            },
            required: ['repoName', 'title']
        },
        handler: async ({ repoName, title, body = '', labels, assignees, milestone }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.issues.create({
                owner, repo, title, body,
                ...(labels?.length && { labels }),
                ...(assignees?.length && { assignees }),
                ...(milestone && { milestone })
            });
            await logger?.info(`Opened issue #${data.number} on ${owner}/${repo}: ${title}`);
            return ok({ repository: `${owner}/${repo}`, ...issueSummary(data) });
        }
    },

    {
        name: 'update_issue',
        sideEffecting: true,
        description: 'Changes an issue: its title, body, state, labels, assignees or milestone. Closing and reopening are done here — pass state. Works for pull requests too.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                issueNumber: num('Issue or pull request number'),
                title: str('New title'),
                body: str('New body'),
                state: enumOf(['open', 'closed'], 'Close or reopen it'),
                stateReason: enumOf(['completed', 'not_planned', 'reopened'], 'Why it was closed'),
                labels: arr('Replace the labels with these'),
                assignees: arr('Replace the assignees with these'),
                milestone: num('Milestone number, or 0 to clear it')
            },
            required: ['repoName', 'issueNumber']
        },
        handler: async (args, { userId, logger }) => {
            const { repoName, issueNumber, title, body, state, stateReason, labels, assignees, milestone } = args;
            const { client, owner, repo } = await clientForRepo(userId, repoName);

            const payload = {
                ...(title !== undefined && { title }),
                ...(body !== undefined && { body }),
                ...(state !== undefined && { state }),
                ...(stateReason !== undefined && { state_reason: stateReason }),
                ...(labels !== undefined && { labels }),
                ...(assignees !== undefined && { assignees }),
                ...(milestone !== undefined && { milestone: milestone === 0 ? null : milestone })
            };

            if (!Object.keys(payload).length) {
                return fail('BAD_ARGUMENTS', 'Nothing to change — pass at least one field.');
            }

            const { data } = await client.rest.issues.update({ owner, repo, issue_number: issueNumber, ...payload });
            await logger?.info(`Updated #${issueNumber} on ${owner}/${repo}: ${Object.keys(payload).join(', ')}`);
            return ok({ repository: `${owner}/${repo}`, changed: Object.keys(payload), ...issueSummary(data) });
        }
    },

    {
        name: 'comment_on_issue',
        sideEffecting: true,
        description: 'Posts a comment on an issue or a pull request. This is how you reply to a discussion or explain something you did.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                issueNumber: num('Issue or pull request number'),
                comment: str('The comment body, in Markdown')
            },
            required: ['repoName', 'issueNumber', 'comment']
        },
        handler: async ({ repoName, issueNumber, comment }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const data = await githubService.addComment(client, owner, repo, issueNumber, comment);
            await logger?.info(`Commented on ${owner}/${repo}#${issueNumber}`);
            return ok({ repository: `${owner}/${repo}`, issueNumber, url: data.html_url, posted: true });
        }
    },

    {
        name: 'list_labels',
        description: 'Lists the labels defined on a repository, with their colours and descriptions.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, limit: num('How many to return') },
            required: ['repoName']
        },
        handler: async ({ repoName, limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const labels = await collect(client, client.rest.issues.listLabelsForRepo, { owner, repo }, limit ?? 100);
            return ok({
                repository: `${owner}/${repo}`,
                count: labels.length,
                labels: labels.map(l => ({ name: l.name, color: l.color, description: l.description }))
            });
        }
    },

    {
        name: 'create_label',
        sideEffecting: true,
        description: 'Creates a label on a repository, or updates its colour and description if it already exists.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                name: str('Label name'),
                color: str('Six-digit hex colour without the #, e.g. d73a4a'),
                description: str('What the label means')
            },
            required: ['repoName', 'name']
        },
        handler: async ({ repoName, name, color = 'ededed', description = '' }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const hex = String(color).replace(/^#/, '').toLowerCase();
            try {
                const { data } = await client.rest.issues.createLabel({ owner, repo, name, color: hex, description });
                return ok({ repository: `${owner}/${repo}`, label: data.name, created: true });
            } catch (e) {
                if (e.status === 422) {
                    const { data } = await client.rest.issues.updateLabel({
                        owner, repo, name, color: hex, description
                    });
                    return ok({ repository: `${owner}/${repo}`, label: data.name, created: false, updated: true });
                }
                throw e;
            }
        }
    },

    {
        name: 'add_labels',
        sideEffecting: true,
        description: 'Adds labels to an issue or pull request, keeping the ones already on it. Use update_issue if you want to replace them instead.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                issueNumber: num('Issue or pull request number'),
                labels: arr('Label names to add')
            },
            required: ['repoName', 'issueNumber', 'labels']
        },
        handler: async ({ repoName, issueNumber, labels }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.issues.addLabels({
                owner, repo, issue_number: issueNumber, labels
            });
            return ok({
                repository: `${owner}/${repo}`, issueNumber,
                labels: data.map(l => l.name)
            });
        }
    },

    {
        name: 'remove_label',
        sideEffecting: true,
        description: 'Removes one label from an issue or pull request.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                issueNumber: num('Issue or pull request number'),
                label: str('Label name to remove')
            },
            required: ['repoName', 'issueNumber', 'label']
        },
        handler: async ({ repoName, issueNumber, label }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                await client.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `#${issueNumber} in ${owner}/${repo} does not have the label "${label}".`);
                }
                throw e;
            }
            return ok({ repository: `${owner}/${repo}`, issueNumber, removed: label });
        }
    },

    {
        name: 'list_milestones',
        description: 'Lists a repository\'s milestones with their due dates and how many issues each still has open.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                state: enumOf(['open', 'closed', 'all'], 'Defaults to open')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, state = 'open' }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const milestones = await collect(client, client.rest.issues.listMilestones, { owner, repo, state }, 50);
            return ok({
                repository: `${owner}/${repo}`,
                count: milestones.length,
                milestones: milestones.map(m => ({
                    number: m.number,
                    title: m.title,
                    state: m.state,
                    dueOn: m.due_on,
                    open: m.open_issues,
                    closed: m.closed_issues
                }))
            });
        }
    },

    {
        name: 'create_milestone',
        sideEffecting: true,
        description: 'Creates a milestone that issues and pull requests can be grouped under.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                title: str('Milestone title, e.g. v1.0'),
                description: str('What this milestone covers'),
                dueOn: str('ISO date it is due')
            },
            required: ['repoName', 'title']
        },
        handler: async ({ repoName, title, description = '', dueOn = null }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.issues.createMilestone({
                owner, repo, title, description, ...(dueOn && { due_on: new Date(dueOn).toISOString() })
            });
            return ok({ repository: `${owner}/${repo}`, number: data.number, title: data.title, url: data.html_url });
        }
    },

    {
        name: 'search_issues',
        description: 'Searches issues and pull requests across ALL of GitHub using its search syntax. This is the tool for questions that are not about one repository: "my open PRs", "issues assigned to me", "PRs waiting on my review", "issues mentioning me".',
        parameters: {
            type: 'object',
            properties: {
                query: str('GitHub issue-search query, e.g. "is:pr is:open author:@me" or "is:issue assignee:@me label:bug"'),
                sort: enumOf(['created', 'updated', 'comments'], 'Ordering'),
                limit: num('How many to return (default 30)')
            },
            required: ['query']
        },
        handler: async ({ query, sort, limit }, { userId }) => {
            const { client } = await resolveClient(userId);
            try {
                const { data } = await client.rest.search.issuesAndPullRequests({
                    q: query,
                    ...(sort && { sort }),
                    order: 'desc',
                    per_page: clampLimit(limit)
                });
                return ok({
                    query,
                    total: data.total_count,
                    count: data.items.length,
                    results: data.items.map(i => ({
                        repository: i.repository_url?.split('/repos/')[1],
                        ...issueSummary(i)
                    }))
                });
            } catch (e) {
                if (e.status === 422) {
                    return fail('BAD_QUERY', `GitHub rejected that search: ${e.message}`, {
                        hint: 'Search qualifiers must be valid, e.g. is:pr is:open author:USERNAME. '
                            + 'Note that "@me" only resolves when acting as the user, so prefer their actual username.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'flag_stale_issues',
        sideEffecting: true,
        description: 'Finds issues with no activity for over 30 days and posts a warning comment on each. Reports exactly how many were flagged. It warns only, it never closes anything.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                dryRun: bool('List what would be flagged without commenting')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, dryRun }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const result = await advancedWorkflowsService.flagStaleIssues(client, owner, repo, { dryRun });
            await logger?.info(`Flagged ${result.flagged} stale issue(s) in ${owner}/${repo}`);
            return ok({ repository: `${owner}/${repo}`, ...result });
        }
    }
];
