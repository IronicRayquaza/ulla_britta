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
    async getInstallationIdByRepo(repoName) {
        if (!this.client) return null;
        
        // Try narrations first
        const { data } = await this.client
            .from('narrations')
            .select('installation_id')
            .eq('repo_name', repoName)
            .limit(1)
            .single();
        
        return data?.installation_id || null;
    }
}

export default new DatabaseService();
