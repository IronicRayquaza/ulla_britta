import databaseService from './database.service.mjs';
import { VercelService } from './vercel.service.mjs';
import { processEvent } from '../processor.mjs'; 

/**
 * Vercel Sentinel
 * Polls Vercel for failures. Uses DB to prevent duplicates.
 */
class VercelSentinel {
    constructor() {
        // Only look at failures from the recent past. Previously this scanned every
        // ERROR deployment ever recorded (since=0) and leaned entirely on the dedupe
        // table, which floods on the first poll for a new account.
        this.lookbackMs = 6 * 60 * 60 * 1000; // 6 hours
        this.lastPollAt = null;
    }

    /**
     * Scan all active Vercel integrations for new errors.
     */
    async checkForFailures() {
        try {
            const integrations = await databaseService.getAllVercelIntegrations();
            console.log(`🛡️ Sentinel: Found ${integrations?.length || 0} active integrations in DB.`);
            
            if (!integrations || integrations.length === 0) return;

            const pollStartedAt = new Date();
            for (const integration of integrations) {
                await this.checkUserDeployments(integration);
            }
            this.lastPollAt = pollStartedAt;
        } catch (error) {
            console.error('❌ Sentinel Patrol Error:', error.message);
        }
    }

    async checkUserDeployments(integration) {
        try {
            const vercel = new VercelService(integration.access_token, integration.team_id);
            const since = this.lastPollAt || new Date(Date.now() - this.lookbackMs);
            const failures = await vercel.getFailedDeployments(since);

            console.log(`📡 Sentinel: User ${integration.user_id} has ${failures.length} ERROR deployments on Vercel.`);

            if (failures.length > 0) {
                for (const deployment of failures) {
                    await this.processFailure(deployment, integration);
                }
            }
        } catch (error) {
            console.error(`🛡️ Sentinel: API Error for user ${integration.user_id}:`, error.message);
        }
    }

    async processFailure(deployment, integration) {
        // 1. Check if we've already processed this deployment ID in the DB
        const isProcessed = await databaseService.isDeploymentProcessed(deployment.uid);
        if (isProcessed) return;

        // 2. Resolve the Full Repository Name and GitHub Installation ID
        // Vercel meta often has githubCommitOrg and githubCommitRepo
        // No hardcoded owner fallback: guessing the operator's own account would
        // point one user's deployment failure at another user's repository.
        const repoOwner = deployment.meta?.githubCommitOrg || deployment.meta?.githubOrg;
        const repoName = deployment.meta?.githubCommitRepo || deployment.meta?.githubRepo;

        if (!repoOwner || !repoName) {
            console.warn(`⚠️ Deployment ${deployment.uid} has no linked GitHub repository; skipping.`);
            return;
        }
        const fullRepo = `${repoOwner}/${repoName}`;

        // Get the GitHub Installation ID linked to this user
        const installationId = await databaseService.getInstallationIdByRepo(fullRepo, integration.user_id);

        if (!installationId) {
            console.warn(`⚠️ Skipping task for ${fullRepo}: No GitHub Installation found for user.`);
            return;
        }

        console.log(`🚨 Sentinel: Found NEW failure for user ${integration.user_id}: ${deployment.uid} (${fullRepo})`);

        // 3. Mark as 'processing' — NOT 'fixed' yet. We update this after the actual result.
        await databaseService.markDeploymentProcessed(deployment.uid, integration.user_id, deployment.projectId);

        // 4. Build a payload and process
        const event = {
            type: 'vercel_failure', 
            payload: {
                // NOTE: these key names must match what processor.mjs reads for
                // 'vercel_failure'. They previously did not, so getDeploymentLogs()
                // was always called with undefined and this path never worked.
                deployment_id: deployment.uid,
                deploymentUrl: deployment.url,
                project_name: deployment.name,
                projectId: deployment.projectId,
                repository: fullRepo,
                branch: deployment.meta?.githubCommitRef || 'main',
                commit: deployment.meta?.githubCommitSha,
                installationId: installationId,
                userId: integration.user_id
            }
        };

        try {
            // processEvent returns the diagnostics result for vercel_failure, or
            // undefined when it bailed out (no logs, unparseable fix, commit failed).
            // "Did not throw" is NOT the same as "fixed" — only claim a fix when one
            // was actually applied.
            const outcome = await processEvent(event);

            if (outcome && outcome.report_markdown) {
                await databaseService.updateDeploymentStatus(deployment.uid, 'fixed');
                console.log(`✅ Sentinel: Fix confirmed for ${deployment.uid}`);
            } else {
                await databaseService.updateDeploymentStatus(deployment.uid, 'no_fix');
                console.warn(`⚠️ Sentinel: No fix could be produced for ${deployment.uid}.`);
            }
        } catch (fixErr) {
            // ❌ Honest failure — mark as failed so user knows it was NOT fixed
            await databaseService.updateDeploymentStatus(deployment.uid, 'failed');
            console.error(`❌ Sentinel: Fix failed for ${deployment.uid}: ${fixErr.message}`);
        }
    }
}

export default new VercelSentinel();
