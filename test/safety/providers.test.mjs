import { GeminiProvider } from '../../src/providers/gemini.mjs';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.mjs';
import { ProviderRouter } from '../../src/providers/index.mjs';
import { system, user, assistant, toolResult } from '../../src/providers/messages.mjs';
import { check, report } from './harness.mjs';

/**
 * Both adapters must represent the same conversation faithfully, including tool
 * calls and their results. If they don't, failing over mid-run silently drops the
 * work already done — which is exactly what the old gateway did.
 */

const history = [
    system('You are Ulla Britta.'),
    user('review PR 42 on acme/api'),
    assistant('', [{ id: 'call_1', name: 'list_pull_requests', args: { repoName: 'acme/api' } }]),
    toolResult('call_1', 'list_pull_requests', { ok: true, data: { count: 1 } }),
    assistant('I found one open PR.', [])
];

// ── Gemini ──────────────────────────────────────────────────────────────────
{
    const { systemInstruction, contents } = GeminiProvider.contentsFor(history);

    check('the system message becomes systemInstruction', systemInstruction === 'You are Ulla Britta.');
    check('the system message is not also a turn', !contents.some(c => c.parts?.[0]?.text === 'You are Ulla Britta.'));
    check('the user turn is preserved', contents[0].role === 'user' && contents[0].parts[0].text.includes('review PR 42'));
    check('an assistant turn maps to role model', contents[1].role === 'model');
    check('a tool call becomes a functionCall part', contents[1].parts[0].functionCall?.name === 'list_pull_requests');
    check('tool arguments survive', contents[1].parts[0].functionCall.args.repoName === 'acme/api');
    check('a tool result becomes a functionResponse part', contents[2].parts[0].functionResponse?.name === 'list_pull_requests');
    check('the tool result payload survives', contents[2].parts[0].functionResponse.response.ok === true);
    check('no turn has empty parts', contents.every(c => c.parts.length > 0));

    const tools = GeminiProvider.toolsFor([
        { name: 't', description: 'd', parameters: { type: 'object', properties: {} } }
    ]);
    check('tools become functionDeclarations', tools[0].functionDeclarations[0].name === 't');
}

// ── OpenAI-compatible (Groq / OpenRouter) ───────────────────────────────────
{
    const msgs = OpenAICompatibleProvider.messagesFor(history);

    check('the system message stays a system message', msgs[0].role === 'system');
    check('an assistant tool call uses tool_calls', msgs[2].tool_calls?.[0]?.function?.name === 'list_pull_requests');
    check('tool arguments are serialised as JSON', JSON.parse(msgs[2].tool_calls[0].function.arguments).repoName === 'acme/api');
    check('the tool result links back by id', msgs[3].role === 'tool' && msgs[3].tool_call_id === 'call_1');

    const tools = OpenAICompatibleProvider.toolsFor([
        { name: 't', description: 'd', parameters: { type: 'object', properties: {} } }
    ]);
    check('tools become OpenAI function specs', tools[0].type === 'function' && tools[0].function.name === 't');
}

// ── Both adapters see the same conversation ─────────────────────────────────
{
    const gemini = GeminiProvider.contentsFor(history).contents;
    const openai = OpenAICompatibleProvider.messagesFor(history).filter(m => m.role !== 'system');
    check('both adapters carry the same number of turns', gemini.length === openai.length,
        { gemini: gemini.length, openai: openai.length });
}

// ── Failover policy ─────────────────────────────────────────────────────────
{
    check('a 429 is treated as transient', ProviderRouter.isTransient({ status: 429 }));
    check('a 503 is treated as transient', ProviderRouter.isTransient({ status: 503 }));
    check('a quota message is treated as transient', ProviderRouter.isTransient({ message: 'Quota exceeded' }));
    check('a network drop is treated as transient', ProviderRouter.isTransient({ message: 'fetch failed' }));
    check('a 400 is not retried elsewhere', !ProviderRouter.isTransient({ status: 400 }));
    check('a bad API key is not retried elsewhere', !ProviderRouter.isTransient({ status: 401 }));
}

// ── The router actually fails over, and the breaker opens ───────────────────
{
    const attempts = [];
    const down = {
        name: 'primary', available: true,
        complete: async () => { attempts.push('primary'); const e = new Error('429 rate limit'); e.status = 429; throw e; }
    };
    const up = {
        name: 'backup', available: true,
        complete: async () => { attempts.push('backup'); return { text: 'ok', toolCalls: [], usage: {} }; }
    };

    const router = new ProviderRouter([down, up]);
    let switched = null;
    const result = await router.complete({
        messages: history,
        tools: [],
        onProviderSwitch: (name) => { switched = name; }
    });

    check('the request falls through to the backup', result.text === 'ok');
    check('both providers were tried in order', attempts.join(',') === 'primary,backup');
    check('the switch is announced', switched === 'backup');

    // Three failures should open the primary's breaker.
    for (let i = 0; i < 2; i++) await router.complete({ messages: history, tools: [] });
    check('the breaker opens after repeated failures', router.isOpen('primary'));

    attempts.length = 0;
    await router.complete({ messages: history, tools: [] });
    check('an open breaker is skipped entirely', !attempts.includes('primary'), attempts);
}

// ── A non-transient failure is raised, not laundered ────────────────────────
{
    const bad = {
        name: 'primary', available: true,
        complete: async () => { const e = new Error('Invalid API key'); e.status = 401; throw e; }
    };
    const backup = {
        name: 'backup', available: true,
        complete: async () => ({ text: 'should not be reached', toolCalls: [], usage: {} })
    };

    let raised = null;
    try {
        await new ProviderRouter([bad, backup]).complete({ messages: history, tools: [] });
    } catch (e) {
        raised = e.message;
    }
    check('a bad key fails immediately instead of burning every provider', raised === 'Invalid API key', raised);
}

report('providers');
