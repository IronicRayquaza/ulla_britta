import { runAgent, describeOutcome } from '../../src/agent/loop.mjs';
import { ToolRegistry } from '../../src/agent/registry.mjs';
import { ok, fail, system, user } from '../../src/providers/messages.mjs';
import { check, report } from './harness.mjs';

/**
 * The agent must never report success for work it did not perform.
 *
 * The old fallback path ran a single stateless completion, threw away the tool
 * calls it came back with, and replied "✅ Task completed via fallback provider".
 * Under a rate limit it claimed to have done things it had not done.
 */

const baseMessages = [system('You are a test agent.'), user('delete my old repo')];

const registry = new ToolRegistry().register({
    name: 'do_thing',
    description: 'Does a thing.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ok({ done: true })
});

// ── 1. Every provider is down ───────────────────────────────────────────────
{
    const router = {
        async complete() {
            const e = new Error('All providers failed. gemini: 429 rate limit | groq: 429 rate limit');
            e.code = 'ALL_PROVIDERS_FAILED';
            throw e;
        }
    };

    const result = await runAgent({ messages: baseMessages, registry, router, context: {} });

    check('a total provider outage is not a success', result.ok === false);
    check('the failure is reported to the user', /failed/i.test(result.text), result.text);
    check('it states that nothing was done', /no actions were taken/i.test(result.text), result.text);
    check('it does not use a success marker', !result.text.includes('✅'));
    check('nothing was recorded as performed', result.performed.length === 0);
}

// ── 2. The provider dies after some work has already happened ───────────────
{
    let turn = 0;
    const router = {
        async complete() {
            turn++;
            if (turn === 1) {
                return { text: '', toolCalls: [{ id: 't1', name: 'do_thing', args: {} }], usage: {} };
            }
            throw new Error('429 rate limit exceeded');
        }
    };

    const result = await runAgent({ messages: baseMessages, registry, router, context: {} });

    check('a mid-run outage is not a success', result.ok === false);
    check('completed work is still reported', result.text.includes('do_thing'), result.text);
    check('the failure is stated plainly', /failed/i.test(result.text));
    check('the completed action is recorded once', result.performed.length === 1);
}

// ── 3. A model that stops without a closing message ─────────────────────────
// The old code filled this silence with "✅ Execution Complete!" regardless of
// whether the tools had actually succeeded.
{
    const failingRegistry = new ToolRegistry().register({
        name: 'push_file',
        description: 'Pushes a file.',
        parameters: { type: 'object', properties: {} },
        handler: async () => fail('FORBIDDEN', 'Resource not accessible by integration')
    });

    let turn = 0;
    const router = {
        async complete() {
            turn++;
            return turn === 1
                ? { text: '', toolCalls: [{ id: 't1', name: 'push_file', args: {} }], usage: {} }
                : { text: '', toolCalls: [], usage: {} };
        }
    };

    const result = await runAgent({ messages: baseMessages, registry: failingRegistry, router, context: {} });

    check('a failed tool is listed under Failed', /Failed:/.test(result.text), result.text);
    check('a failed tool is not listed under Completed', !/Completed:[\s\S]*push_file/.test(result.text), result.text);
}

// ── 4. The outcome summary never invents success ────────────────────────────
{
    const cancelled = describeOutcome({
        stopReason: 'cancelled',
        text: '',
        performed: [{ name: 'push_file', ok: true }]
    });
    check('a cancelled run says it was cancelled', /cancelled/i.test(cancelled), cancelled);
    check('a cancelled run still reports what completed', cancelled.includes('push_file'));

    const empty = describeOutcome({ stopReason: 'completed', text: '', performed: [] });
    check('doing nothing is stated as nothing', /did not take any action/i.test(empty), empty);
}

// ── 5. A failure the operator has to fix says what to fix ───────────────────
// This text is what a user reads in the chat window. When every model provider
// refused, each refused for its own reason and each reason has its own fix;
// joined into one line they are unreadable.
{
    const err = new Error('No model provider could answer. a | b | c');
    err.code = 'ALL_PROVIDERS_FAILED';
    err.providerErrors = [
        'gemini rejected its API key. Check the key for gemini in the environment.',
        'groq does not serve "openai/gone". Set GROQ_MODEL to a model it currently offers.'
    ];

    const out = describeOutcome({ stopReason: 'error', text: '', performed: [], error: err });

    check('each provider gets its own line', out.split('\n').filter(l => l.startsWith('- ')).length === 2, out);
    check('the model to fix is named', out.includes('GROQ_MODEL'), out);
    check('the key problem is named too', out.includes('rejected its API key'), out);
    check('it does not run the reasons together on one line', !out.includes(' | '), out);

    // An ordinary error is still reported plainly.
    const plain = describeOutcome({
        stopReason: 'error', text: '', performed: [],
        error: new Error('Redis unreachable')
    });
    check('an error with no provider detail reads as before',
        /The run failed:.*Redis unreachable/.test(plain), plain);
}

report('honest failure reporting');
