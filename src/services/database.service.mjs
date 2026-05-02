import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

class DatabaseService {
    constructor() {
        if (SUPABASE_URL && SUPABASE_KEY) {
            this.client = createClient(SUPABASE_URL, SUPABASE_KEY);
            console.log('✅ Supabase Connection Initialized.');
        } else {
            console.warn('⚠️ SUPABASE_URL or SERVICE_KEY missing.');
        }
    }

    async isRunProcessed(runId) {
        if (!this.client) return false;
        const { data } = await this.client
            .from('processed_runs')
            .select('run_id')
            .eq('run_id', runId)
            .single();
        return !!data;
    }

    async markRunProcessed(runId, repoFullName) {
        if (!this.client) return;
        await this.client.from('processed_runs').insert({ run_id: runId, repo_name: repoFullName });
    }

    /**
     * Store Fix with Installation ID for Dashboard visibility.
     */
    async storeFix(repoName, branch, fixData, installationId) {
        if (!this.client) return;
        await this.client.from('auto_fixes').insert({
            repo_name: repoName,
            branch: branch,
            explanation: fixData.explanation,
            files_changed: fixData.filesToFix?.map(f => f.path) || [],
            full_json: fixData,
            installation_id: installationId // LINKED TO FRONTEND
        });
    }

    /**
     * Store Narration with Installation ID.
     */
    async storeNarration(repoName, analysisData, installationId) {
        if (!this.client) return;
        await this.client.from('narrations').insert({
            repo_name: repoName,
            commit_sha: analysisData.commitSha,
            summary: analysisData.summary,
            report_markdown: analysisData.report_markdown,
            full_json: analysisData,
            installation_id: installationId // LINKED TO FRONTEND
        });
    }

    // New: Fetch cached narration
    async getNarration(repoName, commitSha) {
        if (!this.client) return null;
        const { data } = await this.client
            .from('narrations')
            .select('*')
            .eq('repo_name', repoName)
            .eq('commit_sha', commitSha)
            .single();
        return data;
    }

    /**
     * Look up the dashboard user_id associated with a GitHub username/owner.
     */
    async getUserIdByGithubUsername(username) {
        if (!this.client) return null;
        const { data, error } = await this.client
            .from('profiles')
            .select('user_id')
            .eq('github_username', username)
            .single();
        
        if (error || !data) {
            console.warn(`⚠️ No user profile found for GitHub user: ${username}`);
            return null;
        }
        return data.user_id;
    }

    /**
     * Look up the GitHub Installation ID for a repository.
     * We scan narrations/fixes as they contain this mapping.
     */
    /**
     * Store Vercel Integration data (SaaS Mode).
     */
    async storeVercelIntegration(userId, data) {
        if (!this.client) return;

        console.log(`📡 DB: Target URL is ${SUPABASE_URL?.substring(0, 20)}...`);

        // 0. Ensure a dummy profile exists to satisfy Foreign Key constraints
        console.log(`📡 DB: Ensuring profile exists for ${userId}...`);
        const { error: profErr } = await this.client.from('profiles').upsert({ 
            id: userId, 
            username: 'IronicRayquaza',
            email: 'admin@ulla-britta.agent' // Added email just in case it's required
        });

        if (profErr) {
            console.warn(`⚠️ Profile Creation Warning (Might exist): ${profErr.message}`);
        }

        console.log(`📡 DB: Attempting to store integration for ${userId}...`);

        const { error } = await this.client.from('vercel_integrations').upsert({
            user_id: userId,
            access_token: data.access_token,
            configuration_id: data.configuration_id,
            team_id: data.team_id || null,
            user_vercel_id: data.vercel_user_id,
            status: 'active',
            installed_at: new Date().toISOString()
        });

        if (error) {
            console.error('❌ Supabase Store Error:', error.message);
            throw new Error(`Database save failed: ${error.message}`);
        } else {
            console.log(`✅ Vercel Integration Saved for User ${userId}`);
        }
    }

    /**
     * Get all active Vercel integrations (for Sentinel).
     */
    async getAllVercelIntegrations() {
        if (!this.client) return [];
        
        // Debug: Check total count in DB
        const { count, error: countErr } = await this.client
            .from('vercel_integrations')
            .select('*', { count: 'exact', head: true });
        
        console.log(`📊 DB Status: Total Integrations = ${count || 0}`);
        if (countErr) console.error('📊 DB Error:', countErr.message);

        const { data } = await this.client
            .from('vercel_integrations')
            .select('*')
            .eq('status', 'active');
        return data || [];
    }

    /**
     * Retrieve Vercel token by user_id.
     */
    async getVercelToken(userId) {
        if (!this.client) return null;
        const { data } = await this.client
            .from('vercel_integrations')
            .select('access_token')
            .eq('user_id', userId)
            .single();
        return data?.access_token || null;
    }

    /**
     * Check if a deployment has already been handled.
     */
    async isDeploymentProcessed(deploymentId) {
        if (!this.client) return false;
        const { data } = await this.client
            .from('processed_deployments')
            .select('id')
            .eq('deployment_id', deploymentId)
            .single();
        return !!data;
    }

    /**
     * Mark a deployment as handled.
     */
    async markDeploymentProcessed(deploymentId, userId, projectId) {
        if (!this.client) return;
        await this.client.from('processed_deployments').insert({
            deployment_id: deploymentId,
            user_id: userId,
            project_id: projectId,
            status: 'pending'
        });
    }
    /**
     * Look up the GitHub Installation ID for a repository.
     */
    async getInstallationIdByRepo(repoFullName, userId) {
        if (!this.client) return null;
        
        // 1. Try by repo owner name
        let { data } = await this.client
            .from('github_installations')
            .select('installation_id')
            .eq('account_login', repoFullName.split('/')[0])
            .maybeSingle();

        if (data?.installation_id) return data.installation_id;

        // 2. Fallback: Get ANY installation linked to this dashboard user
        if (userId) {
            const { data: userInst } = await this.client
                .from('github_installations')
                .select('installation_id')
                .eq('user_id', userId)
                .limit(1)
                .maybeSingle();
            
            return userInst?.installation_id || null;
        }

        return null;
    }
}

export default new DatabaseService();
