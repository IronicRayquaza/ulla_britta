import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

class LoggerService {
    constructor() {
        this.client = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
        this.context = { userId: null, repo: null, service: 'agent-core' };
    }

    setContext(userId, repo, service = 'agent-core') {
        this.context = { userId, repo, service };
    }

    async log(level, message, metadata = {}) {
        // Fallback: Console log always
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.context.repo || 'system'}] ${message}`);

        if (!this.client || !this.context.userId) return;

        try {
            await this.client.from('agent_logs').insert({
                user_id: this.context.userId,
                repo: this.context.repo,
                level: level,
                service: this.context.service,
                message: message,
                metadata: metadata,
                timestamp: timestamp
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

export default new LoggerService();
