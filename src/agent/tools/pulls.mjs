import { clientForRepo, resolveClient } from '../github-access.mjs';
import * as prService from '../../services/pr.service.mjs';
import { ok, fail, str, num, bool, arr, enumOf, REPO, issueSummary, excerpt, collect, clampLimit } from './common.mjs';

/**
 * Pull requests: reviewing them, opening them, changing them, merging them.
 */
export default [
    {
        name: 'list_pull_requests',
        description: 'Lists pull requests on a repository so you can decide which ones need attention.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                state: enumOf(['open', 'closed', 'all'], 'Defaults to open'),
                base: str('Only PRs targeting this branch'),
                head: str('Only PRs from this branch, "owner:branch"'),
                sort: enumOf(['created', 'updated', 'popularity', 'long-running'], 'Ordering'),
                limit: num('How many to return (default 30)')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, state = 'open', base, head, sort = 'updated', limit }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const data = await collect(client, client.rest.pulls.list, {
                owner, repo, state, sort, direction: 'desc',
                ...(base && { base }),
                ...(head && { head })
            }, limit);

            return ok({
                repository: `${owner}/${repo}`,
                state,
                count: data.length,
                pullRequests: data.map(pr => ({
                    number: pr.number,
                    title: pr.title,
                    author: pr.user?.login,
                    state: pr.state,
                    draft: pr.draft,
                    head: pr.head.ref,
                    base: pr.base.ref,
                    labels: (pr.labels || []).map(l => l.name),
                    reviewers: (pr.requested_reviewers || []).map(r => r.login),
                    updated_at: pr.updated_at,
                    url: pr.html_url
                }))
            });
        }
    },

    {
        name: 'get_pull_request',
        description: 'Reads a pull request in full: metadata, changed files, whether it merges cleanly, and which checks are failing. Use this before reviewing or fixing one.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const pr = await prService.getPullRequest(client, owner, repo, prNumber);
                const { _rawFiles, ...safe } = pr;   // raw patches are too large to return
                return ok(safe);
            } catch (e) {
                if (e.status === 404) {
                    return fail('NOT_FOUND', `There is no pull request #${prNumber} in ${owner}/${repo}.`);
                }
                throw e;
            }
        }
    },

    {
        name: 'create_pull_request',
        sideEffecting: true,
        description: 'Opens a pull request from one branch into another. The head branch must already exist and have commits the base does not.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                title: str('Pull request title'),
                head: str('The branch with your changes'),
                base: str('The branch to merge into. Defaults to the default branch.'),
                body: str('Description, in Markdown'),
                draft: bool('Open as a draft (default false)')
            },
            required: ['repoName', 'title', 'head']
        },
        handler: async ({ repoName, title, head, base = null, body = '', draft = false }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data: meta } = await client.rest.repos.get({ owner, repo });
            const target = base || meta.default_branch;

            try {
                const { data } = await client.rest.pulls.create({
                    owner, repo, title, head, base: target, body, draft
                });
                await logger?.info(`Opened ${owner}/${repo}#${data.number}: ${title}`);
                return ok({
                    repository: `${owner}/${repo}`,
                    number: data.number, title: data.title,
                    head, base: target, draft: data.draft, url: data.html_url
                });
            } catch (e) {
                if (e.status === 422) {
                    return fail('CANNOT_OPEN', `GitHub refused to open that pull request: ${e.message}`, {
                        hint: `Usually this means "${head}" has no commits that "${target}" does not, `
                            + 'or a pull request for that branch is already open.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'update_pull_request',
        sideEffecting: true,
        description: 'Changes a pull request: title, body, base branch, or open/closed state. To mark a draft ready for review, use mark_pull_request_ready.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number'),
                title: str('New title'),
                body: str('New description'),
                base: str('Retarget onto a different base branch'),
                state: enumOf(['open', 'closed'], 'Close or reopen it')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber, title, body, base, state }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const payload = {
                ...(title !== undefined && { title }),
                ...(body !== undefined && { body }),
                ...(base !== undefined && { base }),
                ...(state !== undefined && { state })
            };
            if (!Object.keys(payload).length) {
                return fail('BAD_ARGUMENTS', 'Nothing to change — pass at least one field.');
            }

            const { data } = await client.rest.pulls.update({ owner, repo, pull_number: prNumber, ...payload });
            await logger?.info(`Updated ${owner}/${repo}#${prNumber}: ${Object.keys(payload).join(', ')}`);
            return ok({
                repository: `${owner}/${repo}`, number: data.number,
                changed: Object.keys(payload), state: data.state, url: data.html_url
            });
        }
    },

    {
        name: 'list_pull_request_files',
        description: 'Lists the files a pull request changes, with additions and deletions per file, and optionally the diff itself.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number'),
                includePatches: bool('Include the diff text (default false — it is large)')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber, includePatches = false }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const files = await collect(client, client.rest.pulls.listFiles,
                { owner, repo, pull_number: prNumber }, 100);
            return ok({
                repository: `${owner}/${repo}`,
                prNumber,
                count: files.length,
                files: files.map(f => ({
                    path: f.filename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    ...(includePatches && f.patch && { patch: excerpt(f.patch, 3000) })
                }))
            });
        }
    },

    {
        name: 'list_pull_request_reviews',
        description: 'Lists the reviews left on a pull request and what each reviewer decided. Use this to see whether a PR is approved or blocked.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, prNumber: num('Pull request number') },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const [reviews, { data: pr }] = await Promise.all([
                collect(client, client.rest.pulls.listReviews, { owner, repo, pull_number: prNumber }, 50),
                client.rest.pulls.get({ owner, repo, pull_number: prNumber })
            ]);

            return ok({
                repository: `${owner}/${repo}`,
                prNumber,
                requestedReviewers: (pr.requested_reviewers || []).map(r => r.login),
                count: reviews.length,
                reviews: reviews.map(r => ({
                    reviewer: r.user?.login,
                    state: r.state,
                    at: r.submitted_at,
                    body: excerpt(r.body || '', 800)
                }))
            });
        }
    },

    {
        name: 'submit_pull_request_review',
        sideEffecting: true,
        description: 'Submits a review on a pull request with a decision you have already made: approve it, request changes, or leave a comment. Use review_pull_request instead when you want the changes analysed first.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number'),
                event: enumOf(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], 'The review decision'),
                body: str('The review comment. Required for REQUEST_CHANGES and COMMENT.')
            },
            required: ['repoName', 'prNumber', 'event']
        },
        handler: async ({ repoName, prNumber, event, body = '' }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            if (event !== 'APPROVE' && !body.trim()) {
                return fail('BAD_ARGUMENTS', `A "${event}" review needs a body explaining why.`);
            }
            try {
                const { data } = await client.rest.pulls.createReview({
                    owner, repo, pull_number: prNumber, event, body
                });
                await logger?.info(`Submitted a ${event} review on ${owner}/${repo}#${prNumber}`);
                return ok({ repository: `${owner}/${repo}`, prNumber, event, url: data.html_url, posted: true });
            } catch (e) {
                if (e.status === 422) {
                    return fail('CANNOT_REVIEW', `GitHub refused that review: ${e.message}`, {
                        hint: 'An author cannot approve their own pull request; the app can only leave COMMENT reviews on its own PRs.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'review_pull_request',
        sideEffecting: true,
        description: 'Reviews a pull request against its real diff and posts a GitHub review with inline comments anchored to specific lines.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const result = await prService.reviewPullRequest(client, owner, repo, prNumber);
            await logger?.info(
                result.posted
                    ? `Reviewed ${owner}/${repo}#${prNumber} with ${result.inlineComments} inline comment(s)`
                    : `Did not review ${owner}/${repo}#${prNumber}: ${result.reason}`
            );
            return ok({ repository: `${owner}/${repo}`, prNumber, ...result });
        }
    },

    {
        name: 'request_reviewers',
        sideEffecting: true,
        description: 'Asks specific people or teams to review a pull request.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number'),
                reviewers: arr('GitHub usernames to request'),
                teamReviewers: arr('Team slugs to request (organizations only)')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber, reviewers = [], teamReviewers = [] }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            if (!reviewers.length && !teamReviewers.length) {
                return fail('BAD_ARGUMENTS', 'Name at least one reviewer or team.');
            }
            try {
                const { data } = await client.rest.pulls.requestReviewers({
                    owner, repo, pull_number: prNumber,
                    ...(reviewers.length && { reviewers }),
                    ...(teamReviewers.length && { team_reviewers: teamReviewers })
                });
                return ok({
                    repository: `${owner}/${repo}`, prNumber,
                    requested: (data.requested_reviewers || []).map(r => r.login)
                });
            } catch (e) {
                if (e.status === 422) {
                    return fail('CANNOT_REQUEST', `GitHub refused that: ${e.message}`, {
                        hint: 'A pull request author cannot be requested as its own reviewer, and reviewers must have access to the repository.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'mark_pull_request_ready',
        sideEffecting: true,
        description: 'Takes a pull request out of draft and marks it ready for review.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, prNumber: num('Pull request number') },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
            if (!pr.draft) {
                return ok({ repository: `${owner}/${repo}`, prNumber, ready: true, note: 'It was already out of draft.' });
            }

            // Draft state is only settable through GraphQL.
            await client.graphql(
                `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
                { id: pr.node_id }
            );
            return ok({ repository: `${owner}/${repo}`, prNumber, ready: true });
        }
    },

    {
        name: 'update_pull_request_branch',
        sideEffecting: true,
        description: 'Merges the latest base branch into a pull request\'s branch, bringing an out-of-date PR up to date.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, prNumber: num('Pull request number') },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const { data } = await client.rest.pulls.updateBranch({ owner, repo, pull_number: prNumber });
                await logger?.info(`Updated the branch of ${owner}/${repo}#${prNumber}`);
                return ok({ repository: `${owner}/${repo}`, prNumber, updated: true, message: data.message });
            } catch (e) {
                if (e.status === 422) {
                    return fail('CANNOT_UPDATE', `The branch could not be updated: ${e.message}`, {
                        hint: 'This usually means the branch is already up to date, or the merge would conflict.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'merge_pull_request',
        sideEffecting: true,
        description: 'Merges a pull request. Check first that it is mergeable and its checks pass — this changes the base branch and is awkward to undo. Say what you are merging before you do it.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number'),
                method: enumOf(['merge', 'squash', 'rebase'], 'Merge strategy, default merge'),
                commitTitle: str('Override the merge commit title'),
                commitMessage: str('Override the merge commit body')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber, method = 'merge', commitTitle, commitMessage }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);

            // Read the state first so a refusal explains itself instead of surfacing a 405.
            const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
            if (pr.merged) {
                return ok({ repository: `${owner}/${repo}`, prNumber, merged: true, note: 'It was already merged.' });
            }
            if (pr.state !== 'open') {
                return fail('NOT_OPEN', `${owner}/${repo}#${prNumber} is ${pr.state}, so it cannot be merged.`);
            }
            if (pr.mergeable === false) {
                return fail('NOT_MERGEABLE', `${owner}/${repo}#${prNumber} has conflicts with ${pr.base.ref} and cannot be merged as it stands.`);
            }

            try {
                const { data } = await client.rest.pulls.merge({
                    owner, repo, pull_number: prNumber, merge_method: method,
                    ...(commitTitle && { commit_title: commitTitle }),
                    ...(commitMessage && { commit_message: commitMessage })
                });
                await logger?.info(`Merged ${owner}/${repo}#${prNumber} (${method})`);
                return ok({
                    repository: `${owner}/${repo}`, prNumber,
                    merged: data.merged, method, sha: data.sha, message: data.message
                });
            } catch (e) {
                if (e.status === 405 || e.status === 409) {
                    return fail('MERGE_REFUSED', `GitHub refused the merge: ${e.message}`, {
                        hint: 'Branch protection, required reviews or failing checks usually cause this.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'get_check_failures',
        description: 'Reads the failing CI checks for a commit or branch, with their annotations, so you can see why a build actually broke.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                ref: str('Commit SHA, branch name, or tag')
            },
            required: ['repoName', 'ref']
        },
        handler: async ({ repoName, ref }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            return ok(await prService.getCheckFailures(client, owner, repo, ref));
        }
    },

    {
        name: 'fix_pull_request',
        sideEffecting: true,
        description: 'Reads a pull request, its failing checks and its real file contents, then pushes a fix to the PR branch and comments explaining what changed. Only touches files the PR already changed, and refuses rather than guessing when it cannot determine a correct fix.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                prNumber: num('Pull request number'),
                instruction: str('Optional: what specifically to fix')
            },
            required: ['repoName', 'prNumber']
        },
        handler: async ({ repoName, prNumber, instruction }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const result = await prService.proposePullRequestFix(client, owner, repo, prNumber, instruction);
            await logger?.info(
                result.applied
                    ? `Pushed a fix to ${owner}/${repo}#${prNumber}: ${result.filesChanged.join(', ')}`
                    : `No fix pushed to ${owner}/${repo}#${prNumber}: ${result.reason}`
            );
            return ok({ repository: `${owner}/${repo}`, prNumber, ...result });
        }
    }
];
