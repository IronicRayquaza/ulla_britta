/**
 * Boot-time check that the configured models actually exist.
 *
 * Two of the three hardcoded model defaults in this repo rotted without anyone
 * noticing: Groq decommissioned `llama-3.3-70b-versatile` and OpenRouter dropped
 * `meta-llama/llama-3.3-70b-instruct:free`. Nothing detected either. The first
 * symptom was a user watching a run die on
 * `404 The model llama-3.3-70b-versatile does not exist`, from a fallback path
 * that only runs when the primary is already struggling — the worst possible
 * place to discover a configuration fault.
 *
 * So the catalogue is checked once at startup, against the live provider. This
 * never throws and never blocks boot: an unreachable provider at start-up is not
 * a reason to refuse to serve, and the router handles it at request time anyway.
 */

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @param {object} router   A ProviderRouter.
 * @param {object} [opts]
 * @param {object} [opts.logger]  Anything with warn/info. Defaults to console.
 * @returns {Promise<Array<{provider, model, ok, reason, available}>>}
 */
export async function checkModels(router, {
    logger = console,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    toolSpecs = null
} = {}) {
    const providers = router.providers.filter(p => p.available);

    // Roughly what the tool schema costs on every single request. Four characters
    // per token is close enough to compare against a per-request budget.
    const toolTokens = toolSpecs ? Math.ceil(JSON.stringify(toolSpecs).length / 4) : 0;

    if (providers.length === 0) {
        logger.warn?.('⚠️  No model provider is configured. Set GEMINI_API_KEY or GROQ_API_KEY.');
        return [];
    }

    const results = await Promise.all(providers.map(async (provider) => {
        const base = { provider: provider.name, model: provider.model };

        if (typeof provider.listModels !== 'function') {
            return { ...base, ok: true, reason: 'no catalogue endpoint; not checked' };
        }

        let catalogue;
        try {
            catalogue = await provider.listModels({ timeoutMs });
        } catch (err) {
            // Unreachable at boot is not the same as misconfigured. Say which.
            return { ...base, ok: true, reason: `could not check: ${err.message}` };
        }

        if (!catalogue.length) {
            return { ...base, ok: true, reason: 'catalogue was empty; not checked' };
        }

        if (!catalogue.includes(provider.model)) {
            return { ...base, ok: false, reason: 'not offered', catalogue };
        }

        // Being listed is not the same as working. Google lists
        // gemini-2.5-flash-lite and then answers a real call with "this model is
        // no longer available" — so the catalogue check passed, the model shipped,
        // and every run that reached that tier failed with a 404. The only honest
        // check is to actually call it.
        if (typeof provider.complete === 'function') {
            try {
                await provider.complete({
                    messages: [{ role: 'user', content: 'ok' }],
                    tools: []
                });
            } catch (err) {
                const status = err?.status || err?.response?.status;
                // Throttling and outages say nothing about the configuration.
                if (status === 429 || (status >= 500 && status <= 599)) {
                    return { ...base, ok: true, reason: `could not check: ${err.message}` };
                }
                return { ...base, ok: false, reason: 'call refused', detail: err.message, catalogue };
            }
        }

        // The model exists — but can this key actually send the agent's request?
        // Groq's free tier allows 8,000 tokens per request and the tool schema
        // alone is larger, so every call 413s. The catalogue says nothing about
        // that, and the failure only shows up on the fallback path.
        if (toolTokens && typeof provider.probeTokenLimit === 'function') {
            try {
                const budget = await provider.probeTokenLimit({ timeoutMs });
                if (budget && budget < toolTokens) {
                    return { ...base, ok: false, reason: 'budget too small', budget, toolTokens };
                }
                return { ...base, ok: true, reason: 'available', budget };
            } catch {
                // Not being able to measure is not a fault worth reporting.
            }
        }

        return { ...base, ok: true, reason: 'available' };
    }));

    for (const r of results) {
        // Something proven unusable at boot should not be tried on every step of
        // every run afterwards.
        if (!r.ok && typeof router.disableProvider === 'function') {
            router.disableProvider(r.provider, `${r.provider}: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
        }

        if (r.ok) {
            if (r.reason === 'available') {
                logger.info?.(`✅ ${r.provider}: ${r.model}`);
            } else {
                logger.warn?.(`⚠️  ${r.provider}: ${r.model} — ${r.reason}`);
            }
            continue;
        }

        if (r.reason === 'call refused') {
            const alternatives = (r.catalogue || []).filter(usableForTools).slice(0, 8);
            logger.warn?.(
                `❌ ${r.provider} lists "${r.model}" but refuses to run it: ${r.detail}\n`
                + `   Set ${envVarFor(r.provider)} to something else — try: ${alternatives.join(', ')}`
            );
            continue;
        }

        if (r.reason === 'budget too small') {
            // The model is real and the key is fine; the tier simply cannot carry
            // this agent. Worth saying plainly, because it looks like nothing is
            // wrong right up until a run falls through to it.
            logger.warn?.(
                `❌ ${r.provider} allows ${r.budget} tokens per request, but the agent's tool schema `
                + `alone is about ${r.toolTokens}. Every run that reaches ${r.provider} will be refused.\n`
                + `   Raise that limit, or accept that ${r.provider} is not a usable fallback here.`
            );
            continue;
        }

        // The loud one. Name the model, the fix, and what is actually on offer,
        // so the answer is in the log rather than one API call away.
        const envVar = envVarFor(r.provider);
        const suggestions = (r.catalogue || []).filter(usableForTools).slice(0, 8);
        logger.warn?.(
            `❌ ${r.provider} does not serve "${r.model}". Runs that reach ${r.provider} will fail.\n`
            + `   Set ${envVar} to one of: ${(suggestions.length ? suggestions : (r.catalogue || []).slice(0, 8)).join(', ')}`
        );
    }

    return results;
}

function envVarFor(name) {
    return {
        gemini: 'GEMINI_MODEL',
        'gemini-lite': 'GEMINI_LITE_MODEL',
        groq: 'GROQ_MODEL',
        openrouter: 'OPENROUTER_MODEL'
    }[name] || `${String(name).toUpperCase().replace(/-/g, '_')}_MODEL`;
}

/**
 * Filters the obvious non-candidates out of a suggestion list. The agent needs a
 * chat model with tool calling; offering the operator a speech or embedding model
 * as the fix would be worse than offering nothing.
 */
function usableForTools(id) {
    return !/whisper|tts|embedding|transcribe|guard|image|audio|robotics|computer-use/i.test(id);
}

/**
 * Fire-and-forget wrapper for start-up paths that must not await or throw.
 *
 * It loads the tool registry so the check measures the real request the agent
 * makes, not a hypothetical empty one.
 */
export function checkModelsInBackground(router, opts = {}) {
    if (process.env.NODE_ENV === 'test' || process.env.SKIP_MODEL_PREFLIGHT === 'true') return;

    (async () => {
        let toolSpecs = null;
        try {
            const { buildRegistry } = await import('../agent/tools/index.mjs');
            toolSpecs = buildRegistry().specs();
        } catch {
            // Measuring the payload is a bonus; the catalogue check still runs.
        }
        await checkModels(router, { toolSpecs, ...opts });
    })().catch(() => {});
}

export default checkModels;
