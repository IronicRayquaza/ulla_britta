import { runAgent } from '../../src/agent/loop.mjs';
import { Budget } from '../../src/agent/budget.mjs';
import { ToolRegistry } from '../../src/agent/registry.mjs';
import { ok, fail, system, user } from '../../src/providers/messages.mjs';
import { check, report } from './harness.mjs';

/**
 * The loop's contract:
 *  - it runs as many steps as the work needs, not a fixed number
 *  - it stops honestly when a budget runs out, and says the task is incomplete
 *  - a tool failure is visible to the model so it can change approach
 *  - failing over to another provider keeps the full history
 */

/** A scripted provider router: each entry is one model turn. */
function scriptedRouter(turns, { onComplete = null } = {}) {
    let i = 0;
    return {
        seen: [],
        async complete({ messages }) {
            this.seen.push(messages.map(m => m.role).join(','));
            if (onComplete) await onComplete(messages, i);
            const turn = turns[Math.min(i, turns.length - 1)];
            i++;
            return {
                text: turn.text || '',
                toolCalls: (turn.toolCalls || []).map((c, n) => ({ id: `c${i}_${n}`, ...c })),
                usage: { inputTokens: 10, outputTokens: 5 },
                provider: turn.provider || 'stub',
                model: 'stub'
            };
        }
    };
}

const baseMessages = [system('You are a test agent.'), user('do the thing')];

// ── 1. More than three sequential tool calls complete ────────────────────────
// The previous implementation capped the loop at MAX_ROUNDS = 3, so any task
// needing look → act → verify → correct was cut off mid-thought.
{
    const calls = [];
    const registry = new ToolRegistry();
    for (const n of [1, 2, 3, 4, 5]) {
        registry.register({
            name: `step_${n}`,
            description: `Step ${n}`,
            parameters: { type: 'object', properties: {} },
            handler: async () => { calls.push(n); return ok({ step: n }); }
        });
    }

    const router = scriptedRouter([
        { toolCalls: [{ name: 'step_1', args: {} }] },
        { toolCalls: [{ name: 'step_2', args: {} }] },
        { toolCalls: [{ name: 'step_3', args: {} }] },
        { toolCalls: [{ name: 'step_4', args: {} }] },
        { toolCalls: [{ name: 'step_5', args: {} }] },
        { text: 'All five steps are done.' }
    ]);

    const result = await runAgent({ messages: baseMessages, registry, router, context: {} });

    check('a five-step task runs all five steps', calls.join(',') === '1,2,3,4,5', calls);
    check('the run reports success', result.ok === true);
    check('the final text is the model\'s own', result.text === 'All five steps are done.', result.text);
    check('every action is recorded', result.performed.length === 5);
}

// ── 2. Budget exhaustion is reported honestly ───────────────────────────────
{
    const registry = new ToolRegistry().register({
        name: 'loop_forever',
        description: 'Never finishes.',
        parameters: { type: 'object', properties: {} },
        handler: async () => ok({ more: true })
    });

    // A model that always asks for another tool call.
    const router = scriptedRouter([{ toolCalls: [{ name: 'loop_forever', args: {} }] }]);
    const result = await runAgent({
        messages: baseMessages,
        registry,
        router,
        context: {},
        budget: new Budget({ maxSteps: 4 })
    });

    check('a runaway task stops at the step limit', result.stopReason === 'max_steps', result.stopReason);
    check('it does not claim success', result.ok === false);
    check('it says the task is incomplete', /incomplete/i.test(result.text), result.text);
    check('it lists what it actually did', result.text.includes('loop_forever'));
    check('it never claims a completed action it did not take', !result.text.includes('✅'));
}

// ── 3. Tool failures reach the model as structured results ──────────────────
{
    let attempts = 0;
    const registry = new ToolRegistry().register({
        name: 'flaky',
        description: 'Fails once, then works.',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
            attempts++;
            return attempts === 1
                ? fail('UPSTREAM_ERROR', 'GitHub returned 503', { retryable: true })
                : ok({ recovered: true });
        }
    });

    let sawFailureInHistory = false;
    const router = scriptedRouter(
        [
            { toolCalls: [{ name: 'flaky', args: {} }] },
            { toolCalls: [{ name: 'flaky', args: {} }] },
            { text: 'Recovered after a retry.' }
        ],
        {
            onComplete: (messages) => {
                const toolMsgs = messages.filter(m => m.role === 'tool');
                if (toolMsgs.some(m => m.content.includes('"retryable":true'))) sawFailureInHistory = true;
            }
        }
    );

    const result = await runAgent({ messages: baseMessages, registry, router, context: {} });

    check('the model sees a structured, retryable failure', sawFailureInHistory);
    check('the tool ran again after failing', attempts === 2, { attempts });
    check('the failed attempt is recorded as failed', result.performed.filter(p => !p.ok).length === 1);
    check('the successful retry is recorded', result.performed.filter(p => p.ok).length === 1);
}

// ── 4. Provider failover keeps the whole history ────────────────────────────
// The old gateway rebuilt a fresh, stateless prompt when it failed over, so a
// rate-limited run lost everything it had already done.
{
    const registry = new ToolRegistry().register({
        name: 'record',
        description: 'Records something.',
        parameters: { type: 'object', properties: {} },
        handler: async () => ok({ recorded: true })
    });

    let historyAtFailover = null;
    let turn = 0;

    const failingOverRouter = {
        async complete({ messages, onProviderSwitch }) {
            turn++;
            if (turn === 2) {
                // Primary is rate-limited; the router hands the same history to the backup.
                if (onProviderSwitch) await onProviderSwitch('groq');
                historyAtFailover = messages.map(m => m.role);
            }
            if (turn >= 3) {
                return { text: 'Finished on the backup provider.', toolCalls: [], usage: {}, provider: 'groq' };
            }
            return {
                text: '',
                toolCalls: [{ id: `t${turn}`, name: 'record', args: {} }],
                usage: {},
                provider: turn === 1 ? 'gemini' : 'groq'
            };
        }
    };

    const events = [];
    const result = await runAgent({
        messages: baseMessages,
        registry,
        router: failingOverRouter,
        context: {},
        onEvent: async (e) => events.push(e.type)
    });

    check('the failover is reported as an event', events.includes('provider_switch'));
    check('the backup receives the prior tool result', historyAtFailover?.includes('tool'), historyAtFailover);
    check('the backup receives the prior assistant turn', historyAtFailover?.includes('assistant'), historyAtFailover);
    check('the run completes on the backup', result.ok === true);
    check('work done before the failover is kept', result.performed.length >= 1);
}

// ── 5. A model that answers without tools just answers ──────────────────────
{
    const registry = new ToolRegistry().register({
        name: 'unused',
        description: 'Should not be called.',
        parameters: { type: 'object', properties: {} },
        handler: async () => ok({})
    });

    const router = scriptedRouter([{ text: 'Ulla Britta operates your GitHub account.' }]);
    const result = await runAgent({ messages: baseMessages, registry, router, context: {} });

    check('a plain question needs no tools', result.performed.length === 0);
    check('the answer is passed through unchanged', result.text === 'Ulla Britta operates your GitHub account.');
}

report('agent loop');
