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
     * Get failed deployments since a specific time
     * @param {Date} since - Only get failures after this time
     */
    async getFailedDeployments(since) {
        const sinceTimestamp = since.getTime();
        const url = `${this.baseUrl}/v6/deployments`;
        
        const params = new URLSearchParams({
            limit: '20',
            state: 'ERROR',
            ...(this.teamId && { teamId: this.teamId })
        });

        const response = await fetch(`${url}?${params}`, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Vercel API error: ${errorData.error?.message || response.status}`);
        }

        const data = await response.json();
        
        // Filter deployments that happened after 'since'
        return data.deployments.filter(deployment => {
            const deploymentTime = new Date(deployment.created).getTime();
            return deploymentTime > sinceTimestamp;
        });
    }

    /**
     * Trigger redeploy for a failed build.
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
