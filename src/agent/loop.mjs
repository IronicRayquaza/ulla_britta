import { assistant, toolResult, estimateTokens } from '../providers/messages.mjs';
import { Budget } from './budget.mjs';

/**
 * The agent loop: think → act → observe → repeat, until the model stops asking for
 * tools or the budget runs out.
 *
 * Everything the run does is emitted through `onEvent`, so the same loop can back a
 * blocking HTTP call, a queued worker, or a live stream without changing.
 */

export const EventType = {
    RUN_START: 'run_start',
    THINKING: 'thinking',
    TOOL_CALL: 'tool_call',
    TOOL_RESULT: 'tool_result',
    PROVIDER_SWITCH: 'provider_switch',
    RUN_END: 'run_end',
    ERROR: 'error'
};

/**
 * @param {object}   opts
 * @param {object[]} opts.messages  Normalized history, including the system message.
 * @param {object}   opts.registry  Tool registry (see registry.mjs).
 * @param {object}   opts.router    Provider router.
 * @param {object}   opts.context   Passed to every tool handler (userId, logger, ...).
 * @param {Budget}   [opts.budget]
 * @param {Function} [opts.onEvent]
 */
export async function runAgent({
    messages,
    registry,
    router,
    context,
    budget = new Budget(),
    onEvent = async () => {}
}) {
    const history = [...messages];
    const performed = [];   // tool calls that actually ran, for honest reporting
    let finalText = '';
    let stopReason = 'completed';

    const emit = (type, data = {}) => onEvent({ type, ...data, budget: budget.snapshot() });

    await emit(EventType.RUN_START, { toolCount: registry.list().length });

    try {
        while (true) {
            const spent = budget.exhausted();
            if (spent) {
                stopReason = spent.reason;
                break;
            }

            budget.countStep();
            await emit(EventType.THINKING, { step: budget.steps });

            const turn = await router.complete({
                messages: history,
                tools: registry.specs(),
                onProviderSwitch: (name) => emit(EventType.PROVIDER_SWITCH, { provider: name })
            });

            budget.countTokens(
                (turn.usage?.inputTokens || 0) + (turn.usage?.outputTokens || 0)
                || estimateTokens(history)
            );

            history.push(assistant(turn.text, turn.toolCalls));

            // No tool calls means the model considers itself finished.
            if (!turn.toolCalls || turn.toolCalls.length === 0) {
                finalText = turn.text || '';
                stopReason = 'completed';
                break;
            }

            for (const call of turn.toolCalls) {
                await emit(EventType.TOOL_CALL, { name: call.name, args: call.args, id: call.id });

                const result = await registry.execute(call.name, call.args, context);

                // Structured result: the model can distinguish a failure from a
                // success whose text happens to mention an error, and can tell
                // whether retrying is worth a step.
                await emit(EventType.TOOL_RESULT, {
                    name: call.name,
                    id: call.id,
                    args: call.args,
                    ok: result.ok,
                    result
                });

                performed.push({ name: call.name, args: call.args, ok: result.ok });
                history.push(toolResult(call.id, call.name, result));
            }
        }
    } catch (err) {
        stopReason = 'error';
        finalText = '';
        await emit(EventType.ERROR, { message: err.message, code: err.code || null });

        await emit(EventType.RUN_END, { stopReason, performed });
        return {
            ok: false,
            stopReason,
            error: { message: err.message, code: err.code || null },
            text: describeOutcome({ stopReason, text: '', performed, error: err }),
            performed,
            messages: history,
            budget: budget.snapshot()
        };
    }

    await emit(EventType.RUN_END, { stopReason, performed });

    return {
        ok: stopReason === 'completed',
        stopReason,
        text: describeOutcome({ stopReason, text: finalText, performed }),
        performed,
        messages: history,
        budget: budget.snapshot()
    };
}

/**
 * Builds the user-facing summary.
 *
 * The rule this enforces: never imply success for work that did not happen. If the
 * run stopped early, say so and list what actually ran.
 */
export function describeOutcome({ stopReason, text, performed, error = null }) {
    const succeeded = performed.filter(p => p.ok);
    const failed = performed.filter(p => !p.ok);

    const ledger = () => {
        if (performed.length === 0) return '_No actions were taken._';
        const lines = [];
        if (succeeded.length) {
            lines.push('**Completed:**');
            lines.push(...succeeded.map(p => `- \`${p.name}\``));
        }
        if (failed.length) {
            lines.push('**Failed:**');
            lines.push(...failed.map(p => `- \`${p.name}\``));
        }
        return lines.join('\n');
    };

    if (stopReason === 'completed') {
        if (text && text.trim()) return text;
        // The model finished without a closing message — report the ledger rather
        // than inventing a summary.
        return performed.length
            ? `Done.\n\n${ledger()}`
            : 'I did not take any action, and I have nothing to report.';
    }

    if (stopReason === 'cancelled') {
        return `🛑 **Cancelled.**\n\n${ledger()}`;
    }

    if (stopReason === 'error') {
        return `❌ **The run failed:** ${error?.message || 'unknown error'}\n\n${ledger()}`;
    }

    const why = {
        max_steps: 'I hit my step limit before finishing.',
        max_tokens: 'I hit my token budget before finishing.',
        deadline: 'I ran out of time before finishing.'
    }[stopReason] || 'I stopped before finishing.';

    return `⚠️ **${why}** The task is incomplete.\n\n${ledger()}\n\n_Ask me to continue if you want me to pick up where I stopped._`;
}

export default runAgent;
