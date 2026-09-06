import { GeminiProvider } from '../../src/providers/gemini.mjs';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.mjs';
import { ProviderRouter, Failure } from '../../src/providers/index.mjs';
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
    check('a 400 is not worth waiting on', !ProviderRouter.isTransient({ status: 400 }));
    check('a bad API key is not worth waiting on', !ProviderRouter.isTransient({ status: 401 }));
}

// ── Whose fault was it? ─────────────────────────────────────────────────────
// The router used to ask only "is this transient?" and raise everything else, on
// the reasoning that the same request fails the same way everywhere. That is true
// of a malformed request and false of a model name or a credential — and it is
// how a decommissioned Groq model turned into a dead run rather than a failover.
{
    check('a 429 is transient', ProviderRouter.classify({ status: 429 }) === Failure.TRANSIENT);
    check('a 502 is transient', ProviderRouter.classify({ status: 502 }) === Failure.TRANSIENT);

    check('a missing model belongs to the provider',
        ProviderRouter.classify({ status: 404, message: 'The model `x` does not exist' }) === Failure.PROVIDER);
    check('a 404 phrased as Groq phrases it belongs to the provider',
        ProviderRouter.classify({ message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it' })
        === Failure.PROVIDER);
    check('an unauthorized key belongs to the provider',
        ProviderRouter.classify({ status: 401 }) === Failure.PROVIDER);
    check('a Gemini invalid key (which arrives as 400) belongs to the provider',
        ProviderRouter.classify({ status: 400, message: 'API key not valid. Please pass a valid API key.' })
        === Failure.PROVIDER);

    check('a malformed request belongs to the request',
        ProviderRouter.classify({ status: 400, message: 'Invalid value at tools[0].parameters' }) === Failure.REQUEST);
    check('a 422 belongs to the request',
        ProviderRouter.classify({ status: 422, message: 'context length exceeded' }) === Failure.REQUEST);

    // "Too large" is measured against one provider's budget. Groq's free tier
    // refuses this agent outright because the tool schema exceeds its 8,000-token
    // per-request cap, while Gemini takes the same request happily.
    check('a payload rejected as too large belongs to the provider',
        ProviderRouter.classify({ status: 413 }) === Failure.PROVIDER);
    check('Groq\'s wording for it is recognised',
        ProviderRouter.classify({
            status: 413,
            message: 'Request too large for model `openai/gpt-oss-120b` ... on tokens per minute (TPM): Limit 8000, Requested 8195, please reduce your message size and try again'
        }) === Failure.PROVIDER);
}

// ── Backoff ─────────────────────────────────────────────────────────────────
{
    const withRetryInfo = { status: 429, message: 'Too Many Requests ... "retryDelay":"3s" ...' };
    check('a suggested retry delay is honoured', ProviderRouter.backoffMs(withRetryInfo) === 3000,
        ProviderRouter.backoffMs(withRetryInfo));

    const dailyQuota = { status: 429, message: '"retryDelay":"86400s"' };
    check('an absurd retry delay is capped', ProviderRouter.backoffMs(dailyQuota) <= 5000,
        ProviderRouter.backoffMs(dailyQuota));

    check('with no suggestion it still waits a little',
        ProviderRouter.backoffMs({ status: 429 }) > 0);
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
    // Retry-in-place is exercised on its own below; switching it off here keeps
    // this test about ordering, and keeps it instant.
    const result = await router.complete({
        messages: history,
        tools: [],
        retryThrottled: false,
        onProviderSwitch: (name) => { switched = name; }
    });

    check('the request falls through to the backup', result.text === 'ok');
    check('both providers were tried in order', attempts.join(',') === 'primary,backup', attempts);
    check('the switch is announced', switched === 'backup');

    // Three failures should open the primary's breaker.
    for (let i = 0; i < 2; i++) {
        await router.complete({ messages: history, tools: [], retryThrottled: false });
    }
    check('the breaker opens after repeated failures', router.isOpen('primary'));

    attempts.length = 0;
    await router.complete({ messages: history, tools: [], retryThrottled: false });
    check('an open breaker is skipped entirely', !attempts.includes('primary'), attempts);
}

// ── A provider's own problem must not end the run ───────────────────────────
// This is the exact failure a user hit: Gemini throttled, the router moved to
// Groq, Groq had dropped the configured model, and the 404 killed the run instead
// of reaching the next provider.
{
    const stale = {
        name: 'groq', available: true, model: 'llama-3.3-70b-versatile',
        complete: async () => {
            const e = new Error('The model `llama-3.3-70b-versatile` does not exist or you do not have access to it');
            e.status = 404;
            throw e;
        }
    };
    const working = {
        name: 'openrouter', available: true, model: 'some/model',
        complete: async () => ({ text: 'answered', toolCalls: [], usage: {} })
    };

    const result = await new ProviderRouter([stale, working])
        .complete({ messages: history, tools: [], retryThrottled: false });
    check('a decommissioned model falls over to the next provider', result.text === 'answered', result.text);
}

{
    // Gemini reports a bad key as 400, which the old rule read as "the request is
    // malformed" and raised — taking down providers whose keys were fine.
    const badKey = {
        name: 'gemini', available: true, model: 'gemini-2.5-flash',
        complete: async () => { const e = new Error('API key not valid. Please pass a valid API key.'); e.status = 400; throw e; }
    };
    const working = {
        name: 'groq', available: true, model: 'openai/gpt-oss-120b',
        complete: async () => ({ text: 'answered', toolCalls: [], usage: {} })
    };

    const result = await new ProviderRouter([badKey, working])
        .complete({ messages: history, tools: [], retryThrottled: false });
    check('a rejected key falls over rather than ending the run', result.text === 'answered', result.text);
}

// ── A provider too small for the agent is stepped over ──────────────────────
// Expanding the tool surface to 88 tools pushed the schema past Groq's free-tier
// per-request cap. That must degrade to the next provider, not end the run.
{
    const tooSmall = {
        name: 'groq', available: true, model: 'openai/gpt-oss-120b',
        complete: async () => {
            const e = new Error('Request too large for model `openai/gpt-oss-120b` ... (TPM): Limit 8000, Requested 8195, please reduce your message size and try again');
            e.status = 413;
            throw e;
        }
    };
    const roomy = {
        name: 'openrouter', available: true, model: 'vendor/big',
        complete: async () => ({ text: 'answered', toolCalls: [], usage: {} })
    };

    const result = await new ProviderRouter([tooSmall, roomy])
        .complete({ messages: history, tools: [], retryThrottled: false });
    check('a payload too large for one provider is tried on the next',
        result.text === 'answered', result.text);

    let raised = null;
    try {
        await new ProviderRouter([tooSmall]).complete({ messages: history, tools: [], retryThrottled: false });
    } catch (e) { raised = e; }
    check('and when nothing else can take it, the reason is the size, not a mystery',
        /too large/i.test(raised?.message || ''), raised?.message);
}

// ── A genuinely bad request still stops immediately ─────────────────────────
{
    let backupTried = false;
    const malformed = {
        name: 'primary', available: true, model: 'm',
        complete: async () => { const e = new Error('Invalid value at tools[0].parameters'); e.status = 400; throw e; }
    };
    const backup = {
        name: 'backup', available: true, model: 'm',
        complete: async () => { backupTried = true; return { text: 'should not be reached', toolCalls: [], usage: {} }; }
    };

    let raised = null;
    try {
        await new ProviderRouter([malformed, backup]).complete({ messages: history, tools: [], retryThrottled: false });
    } catch (e) {
        raised = e.message;
    }
    check('a malformed request is raised, not laundered',
        raised === 'Invalid value at tools[0].parameters', raised);
    check('and no other provider is burned on it', backupTried === false);
}

// ── When everything is misconfigured, say what to fix ───────────────────────
{
    const a = {
        name: 'groq', available: true, model: 'openai/gone-120b',
        complete: async () => { const e = new Error('model_not_found'); e.status = 404; throw e; }
    };
    const b = {
        name: 'openrouter', available: true, model: 'vendor/gone:free',
        complete: async () => { const e = new Error('model_not_found'); e.status = 404; throw e; }
    };

    let raised = null;
    try {
        await new ProviderRouter([a, b]).complete({ messages: history, tools: [], retryThrottled: false });
    } catch (e) {
        raised = e;
    }

    check('exhausting every provider is its own error', raised?.code === 'ALL_PROVIDERS_FAILED', raised?.code);
    check('the message names the model that was refused',
        raised?.message.includes('openai/gone-120b'), raised?.message);
    check('the message names the variable that fixes it',
        raised?.message.includes('GROQ_MODEL') && raised?.message.includes('OPENROUTER_MODEL'),
        raised?.message);
    // The old text was a bare upstream string; this is what a user reads at the
    // end of a failed run.
    check('it does not read as an unexplained upstream error',
        !/^All providers failed\./.test(raised?.message || ''), raised?.message);
}

// ── A throttled provider is given one more chance before moving on ──────────
{
    let calls = 0;
    const flaky = {
        name: 'primary', available: true, model: 'm',
        complete: async () => {
            calls++;
            if (calls === 1) { const e = new Error('rate limit'); e.status = 429; throw e; }
            return { text: 'second time lucky', toolCalls: [], usage: {} };
        }
    };
    const backup = {
        name: 'backup', available: true, model: 'm',
        complete: async () => ({ text: 'backup', toolCalls: [], usage: {} })
    };

    const result = await new ProviderRouter([flaky, backup])
        .complete({ messages: history, tools: [], retryThrottled: true });

    check('a throttled provider is retried in place', result.text === 'second time lucky', result.text);
    check('it was called exactly twice', calls === 2, calls);
}

// ── The shipped configuration points at models that exist ───────────────────
{
    // Both of these were real, shipped defaults that the upstream provider had
    // already removed. The names are pinned so a future edit cannot quietly
    // reintroduce a model that is known to be gone.
    const dead = ['llama-3.3-70b-versatile', 'meta-llama/llama-3.3-70b-instruct:free'];
    const configured = new ProviderRouter().providers.map(p => p.model);

    check('no provider is configured with a known-dead model',
        !configured.some(m => dead.includes(m)), configured);
    check('there is a second Gemini tier to absorb throttling',
        configured.filter(m => /^gemini/.test(m)).length >= 2, configured);
}

report('providers');
