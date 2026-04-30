import axios from 'axios';
import databaseService from './database.service.mjs';

/**
 * Vercel Integration Service
 * Manages OAuth handshakes and global account access.
 */
class VercelIntegrationService {
    constructor() {
        this.clientId = process.env.VERCEL_CLIENT_ID;
        this.clientSecret = process.env.VERCEL_CLIENT_SECRET;
        this.redirectUri = `${process.env.APP_URL}/vercel/callback`;
    }

    /**
     * Exchange the temporary 'code' for a permanent access token.
     */
    async exchangeCode(code, userId, configurationId, teamId) {
        try {
            const response = await axios.post('https://api.vercel.com/v2/oauth/access_token', 
                new URLSearchParams({
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                    code: code,
                    redirect_uri: this.redirectUri,
                }).toString(),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            const { access_token, user_id: vercel_user_id } = response.data;

            // Store in Supabase using the new SaaS schema
            await databaseService.storeVercelIntegration(userId, {
                access_token,
                configuration_id: configurationId,
                team_id: teamId,
                vercel_user_id
            });

            return response.data;
        } catch (error) {
            const vercelError = error.response?.data?.error_description || error.response?.data?.error || error.message;
            console.error('❌ Vercel OAuth Exchange Failed:', vercelError);
            throw new Error(vercelError);
        }
    }

    /**
     * Helper to get the correct token for a specific user.
     */
    async getAccessToken(userId) {
        return await databaseService.getVercelToken(userId);
    }
}

export default new VercelIntegrationService();
