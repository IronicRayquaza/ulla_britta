import { generateText } from './ai.service.mjs';

/**
 * Repository chores.
 *
 * Four methods that used to live here were removed rather than reworded, because
 * they described themselves as doing more than they did:
 *
 *   reviewPullRequest    posted one issue comment while claiming inline comments
 *                        → src/services/pr.service.mjs posts a real review
 *   checkDependencies    asked the model which packages were "notoriously
 *                        outdated" — a guess frozen at its training cutoff
 *                        → src/services/dependencies.service.mjs asks npm
 *   checkRepoHealth      a string template whose verdict was `issues > 10`
 *                        → src/services/health.service.mjs measures real signals
 *   resolveMergeConflicts never fetched a file; its prompt said to *assume* a
 *                        conflict existed and describe how it would be examined
 *                        → removed; a real implementation needs a working merge
 *
 * Each method takes an already-resolved client. Resolving one internally from the
 * repository owner was how a caller could reach a repository it had no right to.
 */
class AdvancedWorkflowsService {
    /** Generates a changelog from the last 20 commits. */
    async generateChangelog(client, owner, repo) {
        const { data: commits } = await client.rest.repos.listCommits({ owner, repo, per_page: 20 });

        if (commits.length === 0) {
            return { commits: 0, changelog: 'This repository has no commits.' };
        }

        const messages = commits
            .map(c => `- ${c.commit.message.split('\n')[0]} (@${c.author?.login || 'unknown'})`)
            .join('\n');

        const changelog = await generateText(
            `Write a CHANGELOG section from these commits, grouped into Features, Fixes and Chores. `
            + `Use only what the commit messages actually say — do not invent entries.\n\n${messages}`
        );

        return { commits: commits.length, range: `${commits.at(-1).sha.slice(0, 7)}..${commits[0].sha.slice(0, 7)}`, changelog };
    }

    /**
     * Comments on issues that have been inactive for over 30 days.
     * Reports the exact number touched, and never claims to have closed anything —
     * it only warns.
     */
    async flagStaleIssues(client, owner, repo, { dryRun = false } = {}) {
        const { data: issues } = await client.rest.issues.listForRepo({
            owner, repo, state: 'open', per_page: 100
        });

        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const stale = issues.filter(i => !i.pull_request && new Date(i.updated_at).getTime() < cutoff);

        if (dryRun) {
            return { scanned: issues.length, stale: stale.length, flagged: 0, dryRun: true,
                     issues: stale.map(i => ({ number: i.number, title: i.title })) };
        }

        const flagged = [];
        const failed = [];
        for (const issue of stale) {
            try {
                await client.rest.issues.createComment({
                    owner, repo,
                    issue_number: issue.number,
                    body: 'This issue has had no activity for over 30 days. '
                        + 'Comment if it is still relevant, otherwise it may be closed.'
                });
                flagged.push(issue.number);
            } catch (e) {
                failed.push({ number: issue.number, error: e.message });
            }
        }

        return { scanned: issues.length, stale: stale.length, flagged: flagged.length, issues: flagged, failed };
    }
}

export default new AdvancedWorkflowsService();
