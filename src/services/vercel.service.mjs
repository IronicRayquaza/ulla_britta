import axios from 'axios';

/**
 * Vercel Service
 * Integration for monitoring and managing Vercel deployments.
 */
class VercelService {
    constructor() {
        this.token = process.env.VERCEL_TOKEN;
        this.baseUrl = 'https://api.vercel.com';
    }

    /**
     * Fetch build logs/events for a specific deployment.
     */
    async getDeploymentLogs(deploymentId) {
        if (!this.token) return "Vercel token not configured.";
        
        try {
            const url = `${this.baseUrl}/v3/deployments/${deploymentId}/events`;
            const { data: events } = await axios.get(url, {
                headers: { Authorization: `Bearer ${this.token}` }
            });

            // Filter for errors and standard error output
            const logs = events
                .filter(e => e.type === 'stderr' || e.payload?.text?.toLowerCase().includes('error'))
                .map(e => e.payload?.text || '')
                .join('\n');

            return logs || "No explicit error logs found in Vercel events.";
        } catch (error) {
            console.error('❌ Failed to fetch Vercel logs:', error.message);
            return `Logs retrieval failed: ${error.message}`;
        }
    }

    /**
     * Triggers a redeployment of an existing deployment.
     */
    async triggerRedeploy(deploymentId) {
        if (!this.token) return null;

        try {
            const url = `${this.baseUrl}/v13/deployments/${deploymentId}/redeploy`;
            const { data } = await axios.post(url, {}, {
                headers: { Authorization: `Bearer ${this.token}` }
            });
            return data.url;
        } catch (error) {
            console.error('❌ Failed to trigger Vercel redeploy:', error.message);
            return null;
        }
    }
}

export default new VercelService();
