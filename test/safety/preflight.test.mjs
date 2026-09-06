import { checkModels } from '../../src/providers/preflight.mjs';
import { check, report } from './harness.mjs';

/**
 * The boot-time model check.
 *
 * Two shipped model defaults were decommissioned upstream and nothing noticed.
 * The first symptom was a user's run dying on
 * `404 The model llama-3.3-70b-versatile does not exist` — from a fallback path
 * that only runs when the primary is already struggling, which is the worst place
 * to find out. This check has to be loud when a model is gone, and entirely silent
 * about things it merely could not reach.
 */

/** Captures what was logged, so the assertions can read it. */
function recorder() {
    const lines = { warn: [], info: [] };
    return {
        lines,
        warn: (m) => lines.warn.push(String(m)),
        info: (m) => lines.info.push(String(m)),
        all: () => [...lines.warn, ...lines.info].join('\n')
    };
}

const provider = (name, model, { available = true, models = null, fail = null, callFails = null } = {}) => ({
    name, model, available,
    ...(models || fail ? {
        listModels: async () => {
            if (fail) throw new Error(fail);
            return models;
        }
    } : {}),
    complete: async () => {
        if (callFails) throw Object.assign(new Error(callFails.message), { status: callFails.status });
        return { text: 'ok', toolCalls: [], usage: {} };
    }
});

// ── A model that is gone must be impossible to miss ─────────────────────────
{
    const log = recorder();
    const results = await checkModels({
        providers: [provider('groq', 'llama-3.3-70b-versatile', {
            models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'whisper-large-v3', 'qwen/qwen3.8-27b']
        })]
    }, { logger: log });

    check('a missing model is reported as not ok', results[0].ok === false, results[0]);
    check('the warning names the model that is gone',
        log.lines.warn.some(l => l.includes('llama-3.3-70b-versatile')), log.lines.warn);
    check('the warning names the provider',
        log.lines.warn.some(l => l.includes('groq')), log.lines.warn);
    check('the warning names the variable that fixes it',
        log.lines.warn.some(l => l.includes('GROQ_MODEL')), log.lines.warn);
    check('the warning lists models that do exist',
        log.lines.warn.some(l => l.includes('openai/gpt-oss-120b')), log.lines.warn);

    // Suggesting a speech model as the replacement for a chat model would be
    // worse than suggesting nothing.
    check('it does not suggest a model that cannot hold a conversation',
        !log.all().includes('whisper-large-v3'), log.all());

    check('the run is not blocked — it warns and returns',
        Array.isArray(results) && results.length === 1);
}

// ── A model that is present is confirmed quietly ────────────────────────────
{
    const log = recorder();
    const results = await checkModels({
        providers: [provider('gemini', 'gemini-2.5-flash', {
            models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
        })]
    }, { logger: log });

    check('a present model is ok', results[0].ok === true);
    check('and is not warned about', log.lines.warn.length === 0, log.lines.warn);
    check('it is confirmed on the info channel',
        log.lines.info.some(l => l.includes('gemini-2.5-flash')), log.lines.info);
}

// ── Unreachable is not the same as misconfigured ────────────────────────────
{
    const log = recorder();
    const results = await checkModels({
        providers: [provider('groq', 'openai/gpt-oss-120b', { fail: 'fetch failed' })]
    }, { logger: log });

    check('a provider that cannot be reached is not called misconfigured',
        results[0].ok === true, results[0]);
    check('the reason says it could not be checked',
        /could not check/.test(results[0].reason), results[0].reason);
    check('and the check never throws', true);
    check('the message does not claim the model is missing',
        !log.all().includes('does not serve'), log.all());
}

// ── Providers with no key are not probed ────────────────────────────────────
{
    const log = recorder();
    let probed = false;
    const unconfigured = {
        name: 'openrouter', model: 'x', available: false,
        listModels: async () => { probed = true; return []; }
    };

    const results = await checkModels({ providers: [unconfigured] }, { logger: log });

    check('an unconfigured provider is skipped', probed === false);
    check('and is not in the results', results.length === 0, results);
    check('with nothing configured at all, that itself is the warning',
        log.lines.warn.some(l => /No model provider is configured/i.test(l)), log.lines.warn);
}

// ── A listed model that refuses to run ──────────────────────────────────────
// The catalogue lies. Google lists gemini-2.5-flash-lite and answers a real call
// with "this model is no longer available" — so a catalogue-only check passed it,
// it shipped, and every run reaching that tier died on a 404. Being listed is not
// being usable, and only a real call can tell the difference.
{
    const log = recorder();
    const disabled = [];
    const listedButDead = provider('gemini-lite', 'gemini-2.5-flash-lite', {
        models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
        callFails: { status: 404, message: 'This model models/gemini-2.5-flash-lite is no longer available' }
    });

    const results = await checkModels({
        providers: [listedButDead],
        disableProvider: (n, r) => disabled.push([n, r])
    }, { logger: log });

    check('a listed model that will not run is not ok', results[0].ok === false, results[0]);
    check('the reason distinguishes it from a missing model',
        results[0].reason === 'call refused', results[0].reason);
    check('the warning quotes what the provider actually said',
        log.lines.warn.some(l => l.includes('no longer available')), log.lines.warn);
    check('and suggests something else from the catalogue',
        log.lines.warn.some(l => l.includes('gemini-3.5-flash-lite')), log.lines.warn);
    check('the provider is taken out of the ladder',
        disabled.some(([n]) => n === 'gemini-lite'), disabled);
}

{
    // An outage during boot says nothing about the configuration.
    const log = recorder();
    const overloaded = provider('gemini', 'gemini-2.5-flash', {
        models: ['gemini-2.5-flash'],
        callFails: { status: 503, message: 'This model is currently experiencing high demand' }
    });

    const results = await checkModels({ providers: [overloaded] }, { logger: log });
    check('a 503 at boot is not a misconfiguration', results[0].ok === true, results[0]);
    check('and the provider is not condemned for it',
        !log.lines.warn.some(l => l.includes('refuses to run')), log.lines.warn);
}

// ── A model that exists but cannot carry the request ────────────────────────
// The catalogue check alone is not enough: Groq lists openai/gpt-oss-120b and
// still refuses every call, because this agent's tool schema is larger than the
// free tier's whole per-request budget. That looks like a healthy provider right
// up until a run falls through to it.
{
    const log = recorder();
    const cramped = {
        name: 'groq', model: 'openai/gpt-oss-120b', available: true,
        listModels: async () => ['openai/gpt-oss-120b'],
        probeTokenLimit: async () => 8000
    };

    // ~12,000 tokens of schema at four characters per token.
    const fatSpecs = [{ name: 'x', description: 'y'.repeat(48000), parameters: {} }];

    const results = await checkModels({ providers: [cramped] }, { logger: log, toolSpecs: fatSpecs });

    check('a model that cannot take the payload is not ok', results[0].ok === false, results[0]);
    check('the reason is the budget, not the model name',
        results[0].reason === 'budget too small', results[0].reason);
    check('the warning gives both numbers',
        log.lines.warn.some(l => l.includes('8000') && /1\d{4}/.test(l)), log.lines.warn);
    check('it does not mislead by claiming the model is missing',
        !log.all().includes('does not serve'), log.all());
}

{
    // The same provider is fine once the payload fits.
    const log = recorder();
    const roomy = {
        name: 'gemini', model: 'gemini-2.5-flash', available: true,
        listModels: async () => ['gemini-2.5-flash'],
        probeTokenLimit: async () => 1_000_000
    };
    const results = await checkModels({ providers: [roomy] },
        { logger: log, toolSpecs: [{ name: 'x', description: 'y'.repeat(4000), parameters: {} }] });

    check('a provider with room to spare passes', results[0].ok === true, results[0]);
    check('and is not warned about', log.lines.warn.length === 0, log.lines.warn);
}

{
    // Not being able to measure must never be reported as a fault.
    const log = recorder();
    const unmeasurable = {
        name: 'groq', model: 'm', available: true,
        listModels: async () => ['m'],
        probeTokenLimit: async () => { throw new Error('no headers'); }
    };
    const results = await checkModels({ providers: [unmeasurable] },
        { logger: log, toolSpecs: [{ name: 'x', description: 'y'.repeat(4000), parameters: {} }] });

    check('an unmeasurable budget is not a failure', results[0].ok === true, results[0]);
    check('and produces no warning', log.lines.warn.length === 0, log.lines.warn);
}

// ── A provider without a catalogue endpoint is left alone ───────────────────
{
    const log = recorder();
    const results = await checkModels({
        providers: [{ name: 'custom', model: 'whatever', available: true }]
    }, { logger: log });

    check('a provider that cannot list models is not failed', results[0].ok === true);
    check('it says why it was skipped', /not checked/.test(results[0].reason), results[0].reason);
}

// ── Several providers are checked together ──────────────────────────────────
{
    const log = recorder();
    const results = await checkModels({
        providers: [
            provider('gemini', 'gemini-2.5-flash', { models: ['gemini-2.5-flash'] }),
            provider('gemini-lite', 'gemini-2.5-flash-lite', { models: ['gemini-2.5-flash'] }),
            provider('groq', 'openai/gpt-oss-120b', { models: ['openai/gpt-oss-120b'] })
        ]
    }, { logger: log });

    check('every configured provider is checked', results.length === 3);
    check('only the broken one is flagged',
        results.filter(r => !r.ok).map(r => r.provider).join(',') === 'gemini-lite',
        results.map(r => `${r.provider}:${r.ok}`));
    check('the lite tier gets its own variable name',
        log.lines.warn.some(l => l.includes('GEMINI_LITE_MODEL')), log.lines.warn);
}

report('model preflight');
