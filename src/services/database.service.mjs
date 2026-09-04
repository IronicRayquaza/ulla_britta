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

        // Make sure a profile row exists to satisfy the foreign key. It previously
        // wrote username: 'IronicRayquaza' and a placeholder email for EVERY user,
        // stamping the operator's identity onto every account that connected Vercel.
        const { error: profErr } = await this.client
            .from('profiles')
            .upsert({ user_id: userId }, { onConflict: 'user_id' });

        if (profErr) {
            console.warn(`⚠️ Could not ensure profile for ${userId}: ${profErr.message}`);
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
        }, { 
            onConflict: 'configuration_id' // This prevents duplicate rows!
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
            status: 'processing'
        });
    }

    /**
     * Update the status of an already-processed deployment.
     * Call with 'fixed' only after the fix is CONFIRMED successful.
     * Call with 'failed' if the fix threw an error.
     */
    async updateDeploymentStatus(deploymentId, status) {
        if (!this.client) return;
        await this.client
            .from('processed_deployments')
            .update({ status, processed_at: new Date().toISOString() })
            .eq('deployment_id', deploymentId);
    }

    /**
     * Look up the GitHub Installation ID for a repository.
     */
    /**
     * The installation this user has that covers `repoFullName`.
     *
     * Every lookup is scoped to the user. The previous version matched on
     * account_login WITHOUT filtering by user_id, so a repository name belonging to
     * another tenant resolved to that tenant's installation — and when that missed,
     * it fell back to "any installation linked to this user", which handed back a
     * client for an account the repository did not belong to.
     *
     * @param {string} repoFullName - "owner/repo", or "" to resolve the user's own
     *                                installation when no repository is in play.
     * @param {string} userId       - Required. Without it there is no tenant to scope to.
     */
    async getInstallationIdByRepo(repoFullName, userId) {
        if (!this.client) return null;

        if (!userId) {
            console.warn('❌ DB: Installation lookup attempted without a user. Refusing.');
            return null;
        }

        const login = (repoFullName || '').split('/')[0];

        // 1. An installation this user owns, on the account that owns the repository.
        if (login) {
            const { data, error } = await this.client
                .from('github_installations')
                .select('installation_id, account_login')
                .eq('user_id', userId)
                .ilike('account_login', login)
                .maybeSingle();

            if (error) console.error('📊 DB Error (installation lookup):', error.message);
            if (data?.installation_id) return data.installation_id;
        }

        // 2. No repository named: the user's own installation. When a repository WAS
        //    named and did not match, we stop here — falling through to an unrelated
        //    installation is how cross-tenant access happens.
        if (!login) {
            const { data } = await this.client
                .from('github_installations')
                .select('installation_id')
                .eq('user_id', userId)
                .order('installed_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (data?.installation_id) return data.installation_id;
        }

        console.warn(`❌ DB: No installation for user ${userId}${login ? ` covering "${login}"` : ''}.`);
        return null;
    }

    /**
     * Records which GitHub account a dashboard user owns.
     *
     * Nothing wrote profiles.github_username before, yet getUserIdByGithubUsername
     * reads it to attribute incoming webhooks — so every webhook fell through to the
     * anonymous system user and its logs reached nobody's dashboard.
     */
    async linkGithubAccount(userId, githubUsername) {
        if (!this.client || !userId || !githubUsername) return;

        const { error } = await this.client
            .from('profiles')
            .upsert({
                user_id: userId,
                github_username: githubUsername,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });

        if (error) {
            console.error(`❌ DB: Could not link GitHub account ${githubUsername}: ${error.message}`);
            throw new Error(`Could not link the GitHub account: ${error.message}`);
        }
        console.log(`✅ DB: ${githubUsername} linked to user ${userId}`);
    }
  /**
   * The email address this user chose during onboarding.
   * Returns null when there is none, so callers can decide whether to fall back.
   */
  async getUserEmail(userId) {
    if (!this.client || !userId) return null;
    const { data, error } = await this.client
      .from('user_preferences')
      .select('email, email_enabled')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn(`⚠️ Could not read email preference for ${userId}: ${error.message}`);
      return null;
    }
    if (!data || data.email_enabled === false) return null;
    return data.email || null;
  }

  /**
   * Fetches recent activity for a user (fixes and deployments).
   */
  async getRecentActivity(userId, limit = 10) {
    if (!this.client) return [];
    
    // We target processed_deployments as the primary source of truth for activity
    const { data, error } = await this.client
      .from('processed_deployments')
      .select('*')
      .eq('user_id', userId)
      .limit(limit);

    if (error) {
        console.error('❌ DB: Activity Query Failed:', error.message);
        return [];
    }
    return data || [];
  }
}

export default new DatabaseService();
