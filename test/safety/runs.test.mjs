import { ToolRegistry } from '../../src/agent/registry.mjs';
import { runAgent } from '../../src/agent/loop.mjs';
import { Budget } from '../../src/agent/budget.mjs';
import { ok, system, user } from '../../src/providers/messages.mjs';
import store from '../../src/runs/store.mjs';
import bus from '../../src/runs/bus.mjs';
import agentService from '../../src/agent/index.mjs';
import { executeRun } from '../../src/runs/service.mjs';
import { check, report } from './harness.mjs';

/**
 * Durable runs.
 *
 * A message is a persisted run, watchable live and resumable. The properties that
 * matter: every step is recorded in order, a retry does not repeat side effects,
 * and a cancelled run stops without claiming it finished.
 */

const baseMessages = [system('test'), user('do it')];

// ── 1. Idempotency: a retried run does not repeat a side effect ─────────────
{
    let pushes = 0;
    const registry = new ToolRegistry().register({
        name: 'push_file',
        description: 'Pushes a file.',
        sideEffecting: true,
        parameters: {
            type: 'object',
            properties: { repoName: { type: 'string' }, path: { type: 'string' } },
            required: ['repoName', 'path']
        },
        handler: async ({ path }) => { pushes++; return ok({ path, committed: true }); }
    });

    const args = { repoName: 'acme/api', path: '.github/workflows/ci.yml' };

    // First attempt: the push happens.
    const first = await registry.execute('push_file', args, { userId: 'u1' });
    check('the first attempt performs the action', first.ok && pushes === 1);

    // Retry, carrying what the previous attempt already applied.
    const applied = new Map([
        [ToolRegistry.idempotencyKey('push_file', args), { data: { path: args.path, committed: true } }]
    ]);
    const second = await registry.execute('push_file', args, { userId: 'u1', alreadyApplied: applied });

    check('a retry does not push the same file twice', pushes === 1, { pushes });
    check('the retry still reports success', second.ok === true);
    check('the retry is marked as already applied', second.data.alreadyApplied === true);

    // Different arguments are a different action and must still run.
    const third = await registry.execute('push_file',
        { repoName: 'acme/api', path: 'README.md' },
        { userId: 'u1', alreadyApplied: applied });
    check('a different action is not skipped', pushes === 2 && third.ok);

    // Argument order must not change the identity of an action.
    check('the idempotency key ignores argument order',
        ToolRegistry.idempotencyKey('push_file', { a: 1, b: 2 })
        === ToolRegistry.idempotencyKey('push_file', { b: 2, a: 1 }));

    // Read-only tools are never skipped: repeating them is free and their answer
    // may have changed.
    let reads = 0;
    registry.register({
        name: 'get_file',
        description: 'Reads a file.',
        parameters: { type: 'object', properties: {} },
        handler: async () => { reads++; return ok({ content: 'x' }); }
    });
    await registry.execute('get_file', {}, { userId: 'u1', alreadyApplied: applied });
    await registry.execute('get_file', {}, { userId: 'u1', alreadyApplied: applied });
    check('read-only tools are never skipped', reads === 2, { reads });
}

// ── 2. Every step is recorded and published, in order ───────────────────────
{
    const recorded = [];
    const published = [];

    const realStore = { ...store };
    store.available = true;
    store.markRunning = async () => {};
    store.finishRun = async (_id, final) => { recorded.push({ final }); };
    store.recordStep = async (_runId, _userId, seq, event) => { recorded.push({ seq, type: event.type }); };
    store.appliedSteps = async () => new Map();

    bus.publish = async (_runId, event) => { published.push(event); };
    bus.clearCancel = async () => {};
    bus.isCancelled = async () => false;

    agentService.processMessage = async (_userId, _message, { onEvent }) => {
        await onEvent({ type: 'thinking', step: 1, budget: {} });
        await onEvent({ type: 'tool_call', name: 'get_file', args: {}, budget: {} });
        await onEvent({ type: 'tool_result', name: 'get_file', ok: true, budget: {} });
        return { ok: true, text: 'done', stopReason: 'completed', performed: [{ name: 'get_file', ok: true }], budget: {} };
    };

    const result = await executeRun({ runId: 'run-1', userId: 'u1', message: 'read a file' });

    const steps = recorded.filter(r => r.seq !== undefined);
    check('every step is persisted', steps.length === 3, steps);
    check('steps are numbered in order', steps.map(s => s.seq).join(',') === '0,1,2', steps.map(s => s.seq));
    check('steps are persisted with their type',
        steps.map(s => s.type).join(',') === 'thinking,tool_call,tool_result');
    check('every step is also published live', published.length >= 3);
    check('a completion frame is published last', published.at(-1).type === 'run_complete');
    check('the completion frame carries the outcome', published.at(-1).ok === true);
    check('the run is finished as completed', recorded.at(-1).final.stopReason === 'completed');
    check('the run returns its result', result.text === 'done');

    Object.assign(store, realStore);
}

// ── 3. A failed run is recorded as failed, not silently dropped ─────────────
{
    const finals = [];
    const published = [];
    store.available = true;
    store.markRunning = async () => {};
    store.recordStep = async () => {};
    store.appliedSteps = async () => new Map();
    store.finishRun = async (_id, final) => { finals.push(final); };
    bus.publish = async (_id, e) => { published.push(e); };
    bus.clearCancel = async () => {};
    bus.isCancelled = async () => false;

    agentService.processMessage = async () => { throw new Error('provider exploded'); };

    let threw = false;
    try {
        await executeRun({ runId: 'run-2', userId: 'u1', message: 'x' });
    } catch {
        threw = true;
    }

    check('the failure propagates so the queue can retry', threw);
    check('the run is recorded as failed', finals[0]?.stopReason === 'error');
    check('the error message is kept', finals[0]?.error === 'provider exploded');
    check('watchers are told it failed', published.at(-1).ok === false);
    check('the failure text does not claim success', !published.at(-1).text.includes('✅'));
}

// ── 4. Cancellation stops a run, and it is not reported as completed ────────
{
    const registry = new ToolRegistry().register({
        name: 'slow_step',
        description: 'Keeps going.',
        parameters: { type: 'object', properties: {} },
        handler: async () => ok({ more: true })
    });

    const budget = new Budget({ maxSteps: 50 });
    const router = {
        async complete() {
            return { text: '', toolCalls: [{ id: 't', name: 'slow_step', args: {} }], usage: {} };
        }
    };

    let steps = 0;
    const result = await runAgent({
        messages: baseMessages,
        registry,
        router,
        context: {},
        budget,
        onEvent: async (e) => {
            if (e.type === 'tool_result') {
                steps++;
                if (steps === 2) budget.cancel('Cancelled from the dashboard');
            }
        }
    });

    check('cancelling stops the loop promptly', steps === 2, { steps });
    check('a cancelled run is not a success', result.ok === false);
    check('the stop reason is cancellation', result.stopReason === 'cancelled');
    check('the user is told it was cancelled', /cancelled/i.test(result.text));
    check('completed work is still listed', result.text.includes('slow_step'));
}

// ── 5. Missing tables degrade instead of breaking the run ───────────────────
{
    const fresh = Object.create(Object.getPrototypeOf(store));
    fresh.client = { from: () => { throw new Error('relation "agent_runs" does not exist'); } };
    fresh.available = true;
    fresh.warned = false;

    let run = null;
    let threw = false;
    try {
        run = await fresh.createRun({ userId: 'u1', input: 'hello' });
    } catch {
        threw = true;
    }

    check('a missing table does not throw', !threw);
    check('a run id is still issued', typeof run?.id === 'string' && run.id.length > 0);
    check('persistence is marked unavailable', fresh.available === false);
    check('later writes become no-ops', await fresh.markRunning('x') === undefined);
}

report('durable runs');
