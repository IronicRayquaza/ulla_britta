import databaseService from './database.service.mjs';
import { VercelService } from './vercel.service.mjs';
import { processor } from '../processor.mjs'; // Assuming processor exists

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
                console.log('🛡️ Sentinel: No active integrations found.');
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
            console.error(`🛡️ Sentinel: Failed to check user ${integration.user_id}:`, error.message);
        }
    }

    async processFailure(deployment, integration) {
        // Build a payload that looks exactly like the webhook payload
        const payload = {
            type: 'deployment.error', // Spoofing the webhook type
            payload: {
                deployment: {
                    id: deployment.uid,
                    url: deployment.url,
                    meta: deployment.meta
                },
                project: {
                    id: deployment.projectId,
                    name: deployment.name,
                    link: {
                        repo: deployment.meta?.githubRepo || deployment.name
                    }
                }
            },
            sentinel: true // Flag to distinguish from real webhooks
        };

        // Pass directly to the processor
        await processor.handleVercelFailure(payload);
    }
}

export default new VercelSentinel();
