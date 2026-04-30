import databaseService from './database.service.mjs';
import { VercelService } from './vercel.service.mjs';
import { processEvent } from '../processor.mjs'; 

/**
 * Vercel Sentinel
 * Polls Vercel for failures when webhooks are unavailable.
 */
class VercelSentinel {
    constructor() {
        this.lastCheckTime = new Date(Date.now() - 10 * 60 * 1000); // Start with 10 min ago
    }

    /**
     * Scan all active Vercel integrations for new errors.
     */
    async checkForFailures() {
        console.log('🛡️ Sentinel: Patrolling for Vercel failures...');

        try {
            const integrations = await databaseService.getAllVercelIntegrations();
            
            if (!integrations || integrations.length === 0) {
                return;
            }

            for (const integration of integrations) {
                await this.checkUserDeployments(integration);
            }

            this.lastCheckTime = new Date();
        } catch (error) {
            console.error('❌ Sentinel Patrol Error:', error.message);
        }
    }

    async checkUserDeployments(integration) {
        try {
            const vercel = new VercelService(integration.access_token, integration.team_id);
            const failures = await vercel.getFailedDeployments(this.lastCheckTime);

            if (failures.length > 0) {
                console.log(`🚨 Sentinel: Found ${failures.length} failures for user ${integration.user_id}`);
                
                for (const deployment of failures) {
                    await this.processFailure(deployment, integration);
                }
            }
        } catch (error) {
            // Silencing token errors to prevent log spam
        }
    }

    async processFailure(deployment, integration) {
        // Build a payload that looks exactly like the internal vercel_failure event
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

        // Pass to the main event processor
        await processEvent(event);
    }
}

export default new VercelSentinel();
