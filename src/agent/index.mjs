import { runAgent, EventType } from './loop.mjs';
import { Budget } from './budget.mjs';
import { buildRegistry } from './tools/index.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { gatherContext } from './context.mjs';
import { ConfirmationStore } from './registry.mjs';
import router from '../providers/index.mjs';
import { system, user } from '../providers/messages.mjs';
import logger from '../services/logger.service.mjs';

/**
 * Entry point for agent runs.
 *
 * Conversation state lives per user rather than on a shared singleton. The old
 * service kept pendingPlan and autopilotActive as instance fields on one exported
 * object, so one user's "go ahead" could execute another user's pending plan.
 */
export class AgentService {
    constructor() {
        this.registry = buildRegistry();
        this.confirmations = new ConfirmationStore();

        // userId -> normalized message history. Phase 2 moves this into Postgres so
        // it survives a restart; keeping the shape identical makes that a swap.
        this.histories = new Map();
        this.maxHistoryMessages = 60;

        // runId -> Budget, so a run can be cancelled from outside the loop.
        this.activeRuns = new Map();
    }

    getHistory(userId) {
        if (!this.histories.has(userId)) this.histories.set(userId, []);
        return this.histories.get(userId);
    }

    resetHistory(userId) {
        this.histories.delete(userId);
    }

    /** Trims oldest turns, never the system message. */
    trimHistory(messages) {
        if (messages.length <= this.maxHistoryMessages) return messages;
        const excess = messages.length - this.maxHistoryMessages;
        return messages.slice(excess);
    }

    cancel(runId, reason = 'Cancelled by user') {
        const budget = this.activeRuns.get(runId);
        if (!budget) return false;
        budget.cancel(reason);
        return true;
    }

    /**
     * Runs one user message to completion.
     *
     * @param {string}   userId
     * @param {string}   message
     * @param {object}   [opts]
     * @param {Function} [opts.onEvent]  Receives every step as it happens.
     * @param {string}   [opts.runId]
     * @param {object}   [opts.budget]   Budget overrides.
     */
    async processMessage(userId, message, {
        onEvent = async () => {},
        runId = null,
        budget: budgetOpts = {},
        alreadyApplied = null
    } = {}) {
        const turn = this.confirmations.beginTurn(userId);
        const runLogger = logger.forRun ? logger.forRun(userId, null, 'agent') : logger;

        await runLogger.info(`Message received (turn ${turn}): "${message.substring(0, 80)}"`);

        const budget = new Budget(budgetOpts);
        if (runId) this.activeRuns.set(runId, budget);

        try {
            const ctx = await gatherContext(userId);
            if (ctx.degraded) {
                await runLogger.warn('Could not load the repository inventory; starting without it.');
            }

            // The system message is rebuilt each turn so the inventory stays current,
            // and is never appended to history (the old code pushed it as a user
            // message every turn, so it accumulated N times).
            const history = this.trimHistory(this.getHistory(userId));
            const messages = [
                system(buildSystemPrompt(ctx)),
                ...history,
                user(message)
            ];

            const result = await runAgent({
                messages,
                registry: this.registry,
                router,
                budget,
                context: {
                    userId,
                    logger: runLogger,
                    confirmations: this.confirmations.forUser(userId),
                    // Side effects a previous attempt of this run already applied,
                    // so a retry does not repeat them.
                    alreadyApplied
                },
                onEvent: async (event) => {
                    await this.logEvent(runLogger, event);
                    await onEvent(event);
                }
            });

            // Persist the turn minus the system message, which is rebuilt each time.
            this.histories.set(userId, this.trimHistory(result.messages.filter(m => m.role !== 'system')));

            return {
                text: result.text,
                ok: result.ok,
                stopReason: result.stopReason,
                performed: result.performed,
                budget: result.budget
            };
        } finally {
            if (runId) this.activeRuns.delete(runId);
        }
    }

    /**
     * Mirrors loop events into the log stream the dashboard subscribes to.
     * These use the same human phrasing the run timeline shows, so the log is
     * readable on its own rather than a list of tool names.
     */
    async logEvent(runLogger, event) {
        switch (event.type) {
            case EventType.THINKING:
                return runLogger.info(`Thinking (step ${event.step}/${event.budget.maxSteps})`);
            case EventType.NARRATION:
                return runLogger.info(event.text);
            case EventType.TOOL_CALL:
                return runLogger.info(event.narration || `Calling ${event.name}`, { args: event.args });
            case EventType.TOOL_RESULT:
                return event.ok
                    ? runLogger.success(event.narration || `${event.name} succeeded`)
                    : runLogger.warn(event.narration || `${event.name} failed`);
            case EventType.PROVIDER_SWITCH:
                return runLogger.warn(`Primary model unavailable — continuing on ${event.provider}`);
            case EventType.ERROR:
                return runLogger.error(`Run failed: ${event.message}`);
            case EventType.RUN_END:
                return runLogger.info(`Run finished (${event.stopReason}), ${event.performed.length} action(s)`);
            default:
                return undefined;
        }
    }
}

export default new AgentService();
