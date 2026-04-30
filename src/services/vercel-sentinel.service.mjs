import databaseService from './database.service.mjs';
import { VercelService } from './vercel.service.mjs';
import { processEvent } from '../processor.mjs'; 

/**
 * Vercel Sentinel
 * Polls Vercel for failures. Uses DB to prevent duplicates.
 */
class VercelSentinel {
    /**
     * Scan all active Vercel integrations for new errors.
     */
    async checkForFailures() {
        try {
            const integrations = await databaseService.getAllVercelIntegrations();
            console.log(`🛡️ Sentinel: Found ${integrations?.length || 0} active integrations in DB.`);
            
            if (!integrations || integrations.length === 0) return;

            for (const integration of integrations) {
                await this.checkUserDeployments(integration);
            }
        } catch (error) {
            console.error('❌ Sentinel Patrol Error:', error.message);
        }
    }

    async checkUserDeployments(integration) {
        try {
            const vercel = new VercelService(integration.access_token, integration.team_id);
            const failures = await vercel.getFailedDeployments(null); 

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

        console.log(`🚨 Sentinel: Found NEW failure for user ${integration.user_id}: ${deployment.uid}`);

        // 2. Mark as processed immediately
        await databaseService.markDeploymentProcessed(deployment.uid, integration.user_id, deployment.projectId);

        // 3. Build a payload and process
        const event = {
            type: 'vercel_failure', 
            payload: {
                deploymentId: deployment.uid,
                deploymentUrl: deployment.url,
                projectId: deployment.projectId,
                projectName: deployment.name,
                repository: deployment.meta?.githubRepo,
                userId: integration.user_id
            }
        };

        await processEvent(event);
    }
}

export default new VercelSentinel();
