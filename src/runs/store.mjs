import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

/**
 * Persistence for agent runs and their steps.
 *
 * Degrades deliberately: if migrations/001_agent_runs.sql has not been applied yet,
 * every write becomes a no-op and the run still executes and streams. Losing the
 * transcript is acceptable; refusing to run because a table is missing is not. The
 * degraded state is reported once rather than silently swallowed.
 */
class RunStore {
    constructor() {
        this.client = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
        this.available = this.client !== null;
        this.warned = false;
    }

    /** Reports a missing-table / permission / connectivity problem once. */
    degrade(error) {
        this.available = false;
        if (!this.warned) {
            console.warn(
                `⚠️ Run persistence is unavailable (${error?.message || 'unknown'}). ` +
                'Runs will execute and stream but will not be saved. ' +
                'Apply migrations/001_agent_runs.sql to enable history.'
            );
            this.warned = true;
        }
    }

    /**
     * Runs one database operation, absorbing every way it can fail.
     *
     * Supabase reports a missing table through the returned `error`, but a
     * misconfigured client or a dropped connection throws instead. Both have to
     * degrade the store, or a database problem would take the whole run down with
     * it — which is exactly what persistence is not allowed to do.
     */
    async attempt(operation, fallback = undefined, { ignoreCodes = [] } = {}) {
        if (!this.available) return fallback;
        try {
            const { data, error } = await operation();
            if (error && !ignoreCodes.includes(error.code)) {
                this.degrade(error);
                return fallback;
            }
            return data ?? fallback;
        } catch (thrown) {
            this.degrade(thrown);
            return fallback;
        }
    }

    async createRun({ userId, input, budget = {} }) {
        const run = {
            id: randomUUID(),
            user_id: userId,
            status: 'queued',
            input,
            budget,
            created_at: new Date().toISOString()
        };

        // The run id is issued locally, so a run can still start and stream even
        // when it cannot be recorded.
        await this.attempt(() => this.client.from('agent_runs').insert(run));
        return run;
    }

    async markRunning(runId) {
        await this.attempt(() => this.client
            .from('agent_runs')
            .update({ status: 'running', started_at: new Date().toISOString() })
            .eq('id', runId));
    }

    /**
     * Records the final state.
     * `incomplete` is stored separately from `completed` so a run that ran out of
     * budget is never later read back as a success.
     */
    async finishRun(runId, { stopReason, text, error = null, usage = {} }) {
        const status = {
            completed: 'completed',
            cancelled: 'cancelled',
            error: 'failed'
        }[stopReason] || 'incomplete';

        await this.attempt(() => this.client
            .from('agent_runs')
            .update({
                status,
                stop_reason: stopReason,
                result: text || null,
                error: error || null,
                usage,
                finished_at: new Date().toISOString()
            })
            .eq('id', runId));
    }

    async recordStep(runId, userId, seq, event) {
        const row = {
            run_id: runId,
            user_id: userId,
            seq,
            type: event.type,
            tool_name: event.name || null,
            args: event.args || null,
            result: event.result || null,
            ok: typeof event.ok === 'boolean' ? event.ok : null,
            tokens: event.budget?.tokens || 0
        };

        // 23505 is the unique (run_id, seq) violation: this step was already
        // recorded by an earlier attempt, which is the constraint doing its job.
        await this.attempt(
            () => this.client.from('agent_steps').insert(row),
            undefined,
            { ignoreCodes: ['23505'] }
        );
    }

    /** Steps already recorded for a run, oldest first. Used to replay a stream. */
    async getSteps(runId, userId) {
        return await this.attempt(() => this.client
            .from('agent_steps')
            .select('*')
            .eq('run_id', runId)
            .eq('user_id', userId)
            .order('seq', { ascending: true }), []) || [];
    }

    async getRun(runId, userId) {
        return await this.attempt(() => this.client
            .from('agent_runs')
            .select('*')
            .eq('id', runId)
            .eq('user_id', userId)     // never serve another user's run
            .maybeSingle(), null);
    }

    async listRuns(userId, limit = 20) {
        return await this.attempt(() => this.client
            .from('agent_runs')
            .select('id, status, input, result, stop_reason, created_at, finished_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit), []) || [];
    }

    /**
     * Side effects a previous attempt of this run already applied successfully,
     * keyed by tool name and arguments.
     *
     * Keying on (tool, args) rather than step number is what makes this correct: a
     * retried run re-plans from scratch and will not reproduce the same step
     * numbering, but pushing the same file with the same content, or opening the
     * same issue, is recognisably the same action.
     */
    async appliedSteps(runId) {
        const applied = new Map();

        const rows = await this.attempt(() => this.client
            .from('agent_steps')
            .select('tool_name, args, result, ok')
            .eq('run_id', runId)
            .eq('type', 'tool_result'), []);

        for (const row of rows || []) {
            if (!row.ok) continue;
            applied.set(RunStore.idempotencyKey(row.tool_name, row.args), row.result);
        }
        return applied;
    }

    static idempotencyKey(toolName, args) {
        // Stable key: sort the argument names so ordering cannot change the hash.
        const stable = args && typeof args === 'object'
            ? JSON.stringify(Object.keys(args).sort().map(k => [k, args[k]]))
            : JSON.stringify(args ?? null);
        return `${toolName}:${stable}`;
    }
}

export default new RunStore();
