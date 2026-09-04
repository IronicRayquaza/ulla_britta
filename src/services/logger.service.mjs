import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

/**
 * A logger bound to one run.
 *
 * The context used to be a mutable field on a shared singleton: two concurrent
 * requests would interleave setContext() calls and write each other's log lines
 * under the wrong user_id, which then streamed to the wrong dashboard. Binding the
 * context to an instance makes that impossible.
 */
class RunLogger {
    constructor(client, { userId, repo, service }) {
        this.client = client;
        this.userId = userId || null;
        this.repo = repo || null;
        this.service = service || 'agent-core';
    }

    /** Returns a logger for the same run, tagged with a repository. */
    forRepo(repo) {
        return new RunLogger(this.client, { userId: this.userId, repo, service: this.service });
    }

    async log(level, message, metadata = {}) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.repo || this.service}] ${message}`);

        // Without a user we have nobody to show this to; console output is enough.
        if (!this.client || !this.userId) return;

        try {
            await this.client.from('agent_logs').insert({
                user_id: this.userId,
                repo: this.repo,
                level,
                service: this.service,
                message,
                metadata,
                timestamp
            });
        } catch (error) {
            console.error('❌ Failed to write to agent_logs:', error.message);
        }
    }

    async info(message, metadata = {}) { await this.log('info', message, metadata); }
    async warn(message, metadata = {}) { await this.log('warn', message, metadata); }
    async error(message, metadata = {}) { await this.log('error', message, metadata); }
    async success(message, metadata = {}) { await this.log('success', message, metadata); }
}

class LoggerService {
    constructor() {
        this.client = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
        // Process-wide logger for startup and background work that belongs to nobody.
        this.context = { userId: null, repo: null, service: 'agent-core' };
    }

    /**
     * Returns an independent logger for one run. Prefer this over setContext:
     * nothing it does can affect a concurrent run.
     */
    forRun(userId, repo = null, service = 'agent-core') {
        return new RunLogger(this.client, { userId, repo, service });
    }

    /**
     * @deprecated Mutates process-wide state and is unsafe under concurrency.
     * Retained for the webhook pipeline until it is moved onto forRun().
     */
    setContext(userId, repo, service = 'agent-core') {
        this.context = { userId: userId || null, repo, service };
    }

    async log(level, message, metadata = {}) {
        const { userId, repo, service } = this.context;
        await new RunLogger(this.client, { userId, repo, service }).log(level, message, metadata);
    }

    async info(message, metadata = {}) { await this.log('info', message, metadata); }
    async warn(message, metadata = {}) { await this.log('warn', message, metadata); }
    async error(message, metadata = {}) { await this.log('error', message, metadata); }
    async success(message, metadata = {}) { await this.log('success', message, metadata); }
}

export default new LoggerService();
