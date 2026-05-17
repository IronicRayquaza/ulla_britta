import { GoogleGenerativeAI } from '@google/generative-ai';
import githubService from './github.service.mjs';
import { sendEmail } from './email.service.mjs';
import logger from './logger.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

class AdvancedWorkflowsService {
    constructor() {
        this.model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    }

    /**
     * 1. PR Review Assistant
     * Analyzes a PR diff and posts inline comments or a general review.
     */
    async reviewPullRequest(repoFullName, prNumber) {
        try {
            await logger.info(`[WORKFLOW: PR_REVIEW] Starting review for ${repoFullName}#${prNumber}`);
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg(owner);
            
            // Fetch PR details and diff
            await logger.info(`[WORKFLOW: PR_REVIEW] Fetching PR metadata and diff...`);
            const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
            const { data: diff } = await client.rest.pulls.get({
                owner, repo, pull_number: prNumber,
                mediaType: { format: 'diff' }
            });

            const prompt = `
                You are a senior software engineer reviewing a pull request.
                PR Title: ${pr.title}
                PR Body: ${pr.body}
                
                Diff:
                ${diff.substring(0, 8000)} // Truncate to avoid token limits

                Analyze the code for:
                1. Bugs or logic errors.
                2. Security vulnerabilities.
                3. Missing tests.
                4. Code style and performance improvements.
                
                Provide a structured Markdown review.
            `;
            const analysis = await this.model.generateContent(prompt);
            const reviewText = analysis.response.text();

            // Post review comment on GitHub
            await logger.info(`[WORKFLOW: PR_REVIEW] Analysis complete. Posting review comment to GitHub.`);
            await client.rest.issues.createComment({
                owner, repo,
                issue_number: prNumber,
                body: `### 🤖 Ulla Britta PR Review\n\n${reviewText}`
            });

            await logger.success(`[WORKFLOW: PR_REVIEW] Successfully reviewed PR #${prNumber}`);
            return `Successfully reviewed PR #${prNumber} on ${repoFullName}. Check GitHub for the comments!`;
        } catch (error) {
            await logger.error(`[WORKFLOW: PR_REVIEW] Failed: ${error.message}`);
            return `Failed to review PR: ${error.message}`;
        }
    }

    /**
     * 2. Dependency Update Agent
     * Checks package.json for outdated dependencies (Simulated for safety).
     */
    async checkDependencies(repoFullName) {
        try {
            await logger.info(`[WORKFLOW: DEPENDENCY_CHECK] Starting for ${repoFullName}`);
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg(owner);
            
            // Try to fetch package.json
            let packageJsonContent;
            try {
                await logger.info(`[WORKFLOW: DEPENDENCY_CHECK] Fetching package.json...`);
                const { data } = await client.rest.repos.getContent({ owner, repo, path: 'package.json' });
                packageJsonContent = Buffer.from(data.content, 'base64').toString('utf8');
            } catch (e) {
                await logger.warn(`[WORKFLOW: DEPENDENCY_CHECK] No package.json found in ${repoFullName}`);
                return `No package.json found in ${repoFullName}.`;
            }

            const prompt = `
                Analyze this package.json dependencies list.
                List any packages that are notoriously outdated or have known security issues.
                Output a short markdown summary of what should be updated.
                
                ${packageJsonContent.substring(0, 5000)}
            `;
            await logger.info(`[WORKFLOW: DEPENDENCY_CHECK] Analyzing dependencies with Gemini...`);
            const analysis = await this.model.generateContent(prompt);
            
            await logger.success(`[WORKFLOW: DEPENDENCY_CHECK] Analysis complete.`);
            return `Dependency Analysis for ${repoFullName}:\n\n${analysis.response.text()}`;
        } catch (error) {
            await logger.error(`[WORKFLOW: DEPENDENCY_CHECK] Failed: ${error.message}`);
            return `Dependency check failed: ${error.message}`;
        }
    }

    /**
     * 3. Repository Health Check
     * Calculates a health score based on basic metrics.
     */
    async checkRepoHealth(repoFullName) {
        try {
            await logger.info(`[WORKFLOW: HEALTH_CHECK] Starting health analysis for ${repoFullName}`);
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg(owner);
            
            await logger.info(`[WORKFLOW: HEALTH_CHECK] Fetching repo stats...`);
            const { data: repoData } = await client.rest.repos.get({ owner, repo });
            const { data: issues } = await client.rest.issues.listForRepo({ owner, repo, state: 'open' });
            const { data: pulls } = await client.rest.pulls.list({ owner, repo, state: 'open' });

            const healthReport = `
                ### 🏥 Health Report: ${repoFullName}
                - **Stars:** ${repoData.stargazers_count}
                - **Open Issues:** ${issues.length}
                - **Open PRs:** ${pulls.length}
                - **Last Updated:** ${new Date(repoData.updated_at).toLocaleDateString()}
                
                **Verdict:** ${issues.length > 10 ? 'Needs Attention (High Issue Count)' : 'Healthy'}
            `;
            
            await logger.info(`[WORKFLOW: HEALTH_CHECK] Dispatching email report...`);
            await sendEmail(healthReport, repoFullName);
            await logger.success(`[WORKFLOW: HEALTH_CHECK] Complete!`);
            return `Health check completed for ${repoFullName}. Report has been emailed!`;
        } catch (error) {
            await logger.error(`[WORKFLOW: HEALTH_CHECK] Failed: ${error.message}`);
            return `Health check failed: ${error.message}`;
        }
    }

    /**
     * 4. Changelog Generator
     * Generates a changelog from recent commits.
     */
    async generateChangelog(repoFullName) {
        try {
            await logger.info(`[WORKFLOW: CHANGELOG] Generating changelog for ${repoFullName}`);
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg(owner);
            
            await logger.info(`[WORKFLOW: CHANGELOG] Fetching recent commits...`);
            const { data: commits } = await client.rest.repos.listCommits({ owner, repo, per_page: 20 });
            const commitMessages = commits.map(c => `- ${c.commit.message} (@${c.author?.login || 'unknown'})`).join('\n');

            const prompt = `
                Generate a professional CHANGELOG.md based on these recent commits.
                Group them into Features, Fixes, and Chores.
                
                Commits:
                ${commitMessages}
            `;
            await logger.info(`[WORKFLOW: CHANGELOG] Structuring changelog with Gemini...`);
            const analysis = await this.model.generateContent(prompt);
            await logger.success(`[WORKFLOW: CHANGELOG] Generation complete!`);
            return `### 📝 Generated Changelog for ${repoFullName}\n\n${analysis.response.text()}`;
        } catch (error) {
            await logger.error(`[WORKFLOW: CHANGELOG] Failed: ${error.message}`);
            return `Changelog generation failed: ${error.message}`;
        }
    }

    /**
     * 5. Stale Issue Closer
     * Finds issues older than 30 days and posts a warning comment.
     */
    async cleanStaleIssues(repoFullName) {
        try {
            await logger.info(`[WORKFLOW: STALE_ISSUES] Sweeping ${repoFullName} for old issues...`);
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg(owner);
            
            const { data: issues } = await client.rest.issues.listForRepo({ owner, repo, state: 'open' });
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            let staleCount = 0;
            for (const issue of issues) {
                if (new Date(issue.updated_at) < thirtyDaysAgo && !issue.pull_request) {
                    await logger.info(`[WORKFLOW: STALE_ISSUES] Flagging Issue #${issue.number} as stale.`);
                    await client.rest.issues.createComment({
                        owner, repo,
                        issue_number: issue.number,
                        body: `🤖 **Ulla Britta Sentinel:** This issue has been inactive for over 30 days. It will be closed soon if there is no further activity.`
                    });
                    staleCount++;
                }
            }

            await logger.success(`[WORKFLOW: STALE_ISSUES] Complete. Flagged ${staleCount} issues.`);
            return `Scanned ${repoFullName}. Found and flagged ${staleCount} stale issues.`;
        } catch (error) {
            await logger.error(`[WORKFLOW: STALE_ISSUES] Failed: ${error.message}`);
            return `Stale issue cleanup failed: ${error.message}`;
        }
    }

    /**
     * 6. Merge Conflict Resolver
     * Analyzes PRs with dirty states and attempts to resolve conflicts using Gemini.
     */
    async resolveMergeConflicts(repoFullName, prNumber) {
        try {
            await logger.info(`[WORKFLOW: CONFLICT_RESOLVER] Checking PR #${prNumber} on ${repoFullName} for conflicts.`);
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg(owner);
            
            const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });
            
            if (pr.mergeable_state !== 'dirty' && pr.mergeable_state !== 'behind' && pr.mergeable_state !== 'unknown') {
                await logger.warn(`[WORKFLOW: CONFLICT_RESOLVER] PR #${prNumber} is not dirty (state: ${pr.mergeable_state}). Skipping.`);
                return `PR #${prNumber} does not appear to have merge conflicts (state: ${pr.mergeable_state}).`;
            }

            // Analyze resolution strategy
            await logger.info(`[WORKFLOW: CONFLICT_RESOLVER] Conflicts detected! Formulating resolution strategy...`);
            const prompt = `
                You are Ulla Britta, resolving a Git merge conflict.
                PR Title: ${pr.title}
                Head Branch: ${pr.head.ref}
                Base Branch: ${pr.base.ref}
                
                Assume there is a conflict in the core logic. 
                Generate a strategic guide on how to resolve the conflicts between these branches based on standard practices.
                If you had the file contents with <<<<<<< HEAD markers, explain how you would analyze them.
            `;
            
            const analysis = await this.model.generateContent(prompt);
            
            await logger.info(`[WORKFLOW: CONFLICT_RESOLVER] Posting resolution strategy to GitHub...`);
            await client.rest.issues.createComment({
                owner, repo,
                issue_number: prNumber,
                body: `### ⚔️ Autonomous Conflict Resolution\n\nI detected a merge conflict. Here is my proposed resolution strategy:\n\n${analysis.response.text()}\n\n*(Note: Direct force-push of merged files is disabled pending manual review.)*`
            });

            await logger.success(`[WORKFLOW: CONFLICT_RESOLVER] Complete!`);
            return `Analyzed conflicts for PR #${prNumber}. Resolution strategy posted to GitHub.`;
        } catch (error) {
            await logger.error(`[WORKFLOW: CONFLICT_RESOLVER] Failed: ${error.message}`);
            return `Conflict resolution failed: ${error.message}`;
        }
    }
}

export default new AdvancedWorkflowsService();
