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
            console.warn('⚠️ SUPABASE_URL or SERVICE_KEY missing. Running in LOCAL-ONLY mode.');
        }
    }

    /**
     * Deduplication: Check if a run ID has been processed.
     */
    async isRunProcessed(runId) {
        if (!this.client) return false;
        const { data, error } = await this.client
            .from('processed_runs')
            .select('run_id')
            .eq('run_id', runId)
            .single();
        return !!data;
    }

    /**
     * Mark a run as processed.
     */
    async markRunProcessed(runId, repoFullName) {
        if (!this.client) return;
        await this.client.from('processed_runs').insert({ run_id: runId, repo_name: repoFullName });
    }

    /**
     * Compact storage for Auto-Fixes.
     */
    async storeFix(repoName, branch, fixData) {
        if (!this.client) return;
        const { error } = await this.client.from('auto_fixes').insert({
            repo_name: repoName,
            branch: branch,
            explanation: fixData.explanation,
            files_changed: fixData.filesToFix.map(f => f.path),
            full_json: fixData // Storing the full object for future audit
        });
        if (error) console.error('Database Error (Fix):', error.message);
    }

    /**
     * Compact storage for Narrations (Push Analysis).
     */
    async storeNarration(repoName, analysisData) {
        if (!this.client) return;
        const { error } = await this.client.from('narrations').insert({
            repo_name: repoName,
            summary: analysisData.summary,
            commit_count: analysisData.commitCount,
            full_json: analysisData
        });
        if (error) console.error('Database Error (Narration):', error.message);
    }
}

export default new DatabaseService();
