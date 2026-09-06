import dotenv from 'dotenv';
import { GeminiProvider } from './gemini.mjs';
import { OpenAICompatibleProvider } from './openai-compatible.mjs';

dotenv.config();

/**
 * Provider router with a circuit breaker.
 *
 * Model choice is cost-driven: Gemini's free tier carries the normal load, Groq
 * takes over when Gemini throttles, and OpenRouter is the last resort. Failover
 * hands over the complete normalized history, so a run continues where it left off
 * instead of starting again with amnesia.
 *
 * The ladder has a second Gemini tier on the same key. A long agent run makes one
 * request per step, so a 25-step task can trip a per-minute quota halfway through;
 * dropping to flash-lite keeps the run inside the family it was tuned against
 * instead of switching model vendor mid-thought.
 *
 * Model names rot. `llama-3.3-70b-versatile` was hardcoded here and Groq
 * decommissioned it, which killed every run that ever reached the fallback; the
 * OpenRouter default had gone the same way unnoticed. preflight.mjs now checks
 * these against each provider's live catalogue at boot.
 */

const FAILURE_THRESHOLD = 3;
const BREAKER_RESET_MS = 60_000;

/** Longest we will wait on a 429 before giving up on that provider. */
const MAX_BACKOFF_MS = 5_000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Why a request failed, and therefore what to do about it.
 *
 *   transient — the same call may work shortly. Retry here, then move on.
 *   provider  — wrong model name, bad or unauthorized key. Nothing to retry on
 *               THIS provider, but the next one has a different key and a
 *               different catalogue, so it is very much worth trying.
 *   request   — the request itself is bad. It will fail identically everywhere,
 *               so raise it rather than burning through every provider.
 */
export const Failure = {
    TRANSIENT: 'transient',
    PROVIDER: 'provider',
    REQUEST: 'request'
};

export class ProviderRouter {
    constructor(providers = null) {
        this.providers = providers || [
            new GeminiProvider({
                apiKey: process.env.GEMINI_API_KEY,
                model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
            }),
            // Same key, much larger free allowance. The next hop when the primary
            // is throttled rather than broken.
            //
            // Not gemini-2.5-flash-lite: Google still lists it, and calling it
            // answers "this model is no longer available". A catalogue entry is not
            // proof a model works, which is why preflight.mjs now actually calls it.
            new GeminiProvider({
                name: 'gemini-lite',
                apiKey: process.env.GEMINI_API_KEY,
                model: process.env.GEMINI_LITE_MODEL || 'gemini-3.5-flash-lite'
            }),
            new OpenAICompatibleProvider({
                name: 'groq',
                apiKey: process.env.GROQ_API_KEY,
                baseURL: 'https://api.groq.com/openai/v1',
                model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
            }),
            new OpenAICompatibleProvider({
                name: 'openrouter',
                apiKey: process.env.OPENROUTER_API_KEY,
                baseURL: 'https://openrouter.ai/api/v1',
                model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free'
            })
        ];

        this.breakers = new Map();
        for (const p of this.providers) {
            this.breakers.set(p.name, { failures: 0, openedAt: null });
        }

        // Providers proven unusable for this process: a model the provider will not
        // run, a key it will not accept, a budget the request cannot fit. None of
        // those fix themselves, so retrying one on every step of every run costs a
        // round-trip and fills the log with the same line. Cleared by a restart,
        // which is also when the configuration can have changed.
        this.disabled = new Map();   // name -> reason
    }

    /** Takes a provider out of the ladder for the life of the process. */
    disableProvider(name, reason) {
        if (this.disabled.has(name)) return false;
        this.disabled.set(name, reason);
        return true;
    }

    get availableProviders() {
        return this.providers.filter(p => p.available);
    }

    isOpen(name) {
        const b = this.breakers.get(name);
        if (!b?.openedAt) return false;
        if (Date.now() - b.openedAt > BREAKER_RESET_MS) {
            b.openedAt = null;
            b.failures = 0;
            return false;
        }
        return true;
    }

    recordSuccess(name) {
        const b = this.breakers.get(name);
        if (b) { b.failures = 0; b.openedAt = null; }
    }

    recordFailure(name) {
        const b = this.breakers.get(name);
        if (!b) return;
        b.failures++;
        if (b.failures >= FAILURE_THRESHOLD) b.openedAt = Date.now();
    }

    /**
     * Sorts a failure into one of the three classes above.
     *
     * The router used to ask only "is this transient?" and raise everything else
     * immediately, on the reasoning that the same request fails the same way
     * everywhere. That holds for a malformed request. It does NOT hold for a model
     * name or a credential, which belong to one provider: when Groq stopped
     * serving llama-3.3-70b-versatile, its 404 aborted runs that the next provider
     * would have completed. Gemini reports an invalid key as 400, so that aborted
     * runs too.
     */
    static classify(err) {
        const status = err?.status || err?.response?.status;
        const message = String(err?.message || '').toLowerCase();

        if (status === 429 || (status >= 500 && status <= 599)) return Failure.TRANSIENT;

        // Wrong model, or a key this provider will not accept.
        if (status === 404 || status === 401 || status === 403) return Failure.PROVIDER;

        // "Too large" is measured against THIS provider's budget, not the
        // request's own merit. Groq's free tier caps a request at 8,000 tokens,
        // which the tool schema alone exceeds, while Gemini accepts the same
        // request without blinking. Moving on is right; raising is not.
        if (status === 413) return Failure.PROVIDER;
        if (message.includes('request too large') || message.includes('too many tokens')
            || message.includes('reduce your message size')) {
            return Failure.PROVIDER;
        }
        if (message.includes('does not exist or you do not have access')
            || message.includes('model_not_found')
            || message.includes('api key not valid')
            || message.includes('api_key_invalid')
            || message.includes('permission_denied')
            || message.includes('is not configured')) {
            return Failure.PROVIDER;
        }

        // Gemini 3 refuses a history whose function calls carry no thought
        // signature. The adapter passes signatures through, so this should not
        // happen — but if a tool call ever originates from a provider that issues
        // none, the run should move to a model that does not demand one rather
        // than dying.
        if (message.includes('thought_signature') || message.includes('thoughtsignature')) {
            return Failure.PROVIDER;
        }

        if (status >= 400 && status <= 499) return Failure.REQUEST;

        // No usable status — fall back to reading the message. Network faults and
        // throttling both surface this way through some SDKs.
        if (message.includes('429') || message.includes('rate limit') || message.includes('quota')
            || message.includes('overload') || message.includes('unavailable') || message.includes('timeout')
            || message.includes('etimedout') || message.includes('econnreset') || message.includes('fetch failed')) {
            return Failure.TRANSIENT;
        }

        return Failure.REQUEST;
    }

    /** Retained for callers that only care whether waiting might help. */
    static isTransient(err) {
        return ProviderRouter.classify(err) === Failure.TRANSIENT;
    }

    /**
     * How long to wait before retrying a throttled provider.
     *
     * Google returns a RetryInfo with the real delay; honouring it beats guessing.
     * Capped, because a daily-quota 429 names a delay measured in hours and a run
     * must not sit on it.
     */
    static backoffMs(err, attempt = 1) {
        const match = String(err?.message || '').match(/"?retryDelay"?:\s*"?(\d+(?:\.\d+)?)s/i);
        const suggested = match ? Number(match[1]) * 1000 : 0;
        const fallback = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
        return Math.min(MAX_BACKOFF_MS, suggested || fallback);
    }

    /** Turns a provider failure into something the person reading it can act on. */
    static explain(provider, err) {
        const kind = ProviderRouter.classify(err);
        if (kind !== Failure.PROVIDER) return `${provider.name}: ${err.message}`;

        const envVar = {
            gemini: 'GEMINI_MODEL',
            'gemini-lite': 'GEMINI_LITE_MODEL',
            groq: 'GROQ_MODEL',
            openrouter: 'OPENROUTER_MODEL'
        }[provider.name] || `${provider.name.toUpperCase()}_MODEL`;

        const status = err?.status || err?.response?.status;
        if (status === 401 || status === 403 || /api key/i.test(err.message || '')) {
            return `${provider.name} rejected its API key. Check the key for ${provider.name} in the environment.`;
        }
        if (status === 413 || /request too large|reduce your message size/i.test(err.message || '')) {
            return `${provider.name} refused the request as too large for its per-request budget `
                + `— the agent's tool schema alone is bigger than the tier allows. `
                + `Raise the limit on ${provider.name}, or leave it out of the ladder.`;
        }
        return `${provider.name} does not serve "${provider.model}". `
            + `Set ${envVar} to a model it currently offers.`;
    }

    /**
     * Completes one turn, trying providers in order until one answers.
     *
     * @param {boolean} [opts.retryThrottled] Wait and retry a 429 once before
     *        moving on. Tests turn it off so they do not sleep.
     * @returns {{ text, toolCalls, usage, provider, model }}
     */
    async complete({ messages, tools, onProviderSwitch = null, retryThrottled = true }) {
        const usable = this.availableProviders;
        if (usable.length === 0) {
            throw new Error('No AI provider is configured. Set GEMINI_API_KEY or GROQ_API_KEY.');
        }

        const errors = [];
        let attempted = 0;

        for (const provider of usable) {
            const disabledReason = this.disabled.get(provider.name);
            if (disabledReason) {
                errors.push(disabledReason);
                continue;
            }

            if (this.isOpen(provider.name)) {
                errors.push(`${provider.name}: circuit open`);
                continue;
            }

            attempted++;
            if (attempted > 1 && onProviderSwitch) {
                await onProviderSwitch(provider.name);
            }

            // A throttled provider is worth one short wait: a per-minute quota
            // clears on its own, and staying here keeps the run on the model it
            // started on.
            for (let attempt = 1; attempt <= 2; attempt++) {
                const start = Date.now();
                try {
                    const result = await provider.complete({ messages, tools });
                    this.recordSuccess(provider.name);
                    return { ...result, latencyMs: Date.now() - start };
                } catch (err) {
                    this.recordFailure(provider.name);
                    const kind = ProviderRouter.classify(err);

                    if (kind === Failure.REQUEST) {
                        // Genuinely the request's fault: it fails the same way on
                        // every provider, so say so rather than trying them all.
                        throw err;
                    }

                    if (kind === Failure.TRANSIENT && attempt === 1 && retryThrottled) {
                        await sleep(ProviderRouter.backoffMs(err, attempt));
                        continue;
                    }

                    const explained = ProviderRouter.explain(provider, err);
                    errors.push(explained);

                    // A wrong model, a rejected key or an over-budget request will
                    // fail identically on the next step and the next run. Stop
                    // paying a round-trip for it every time.
                    if (kind === Failure.PROVIDER && this.disableProvider(provider.name, explained)) {
                        console.warn(`⚠️  Taking ${provider.name} out of the ladder: ${explained}`);
                    }
                    break;   // the next provider has a different key and catalogue
                }
            }
        }

        // Every provider is misconfigured or unreachable. This message is what the
        // user reads at the end of a failed run, so it names what to fix.
        const e = new Error(`No model provider could answer. ${errors.join(' | ')}`);
        e.code = 'ALL_PROVIDERS_FAILED';
        e.providerErrors = errors;
        throw e;
    }
}

export default new ProviderRouter();
