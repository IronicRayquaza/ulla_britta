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
 */

const FAILURE_THRESHOLD = 3;
const BREAKER_RESET_MS = 60_000;

export class ProviderRouter {
    constructor(providers = null) {
        this.providers = providers || [
            new GeminiProvider({
                apiKey: process.env.GEMINI_API_KEY,
                model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
            }),
            new OpenAICompatibleProvider({
                name: 'groq',
                apiKey: process.env.GROQ_API_KEY,
                baseURL: 'https://api.groq.com/openai/v1',
                model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
            }),
            new OpenAICompatibleProvider({
                name: 'openrouter',
                apiKey: process.env.OPENROUTER_API_KEY,
                baseURL: 'https://openrouter.ai/api/v1',
                model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free'
            })
        ];

        this.breakers = new Map();
        for (const p of this.providers) {
            this.breakers.set(p.name, { failures: 0, openedAt: null });
        }
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
     * A failure worth failing over for: rate limits, overload, timeouts. A bad
     * request (malformed tools, oversized prompt) will fail identically everywhere,
     * so it is raised immediately instead of burning through every provider.
     */
    static isTransient(err) {
        const status = err?.status || err?.response?.status;
        if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
        const m = String(err?.message || '').toLowerCase();
        return m.includes('429') || m.includes('rate limit') || m.includes('quota')
            || m.includes('overload') || m.includes('unavailable') || m.includes('timeout')
            || m.includes('etimedout') || m.includes('econnreset') || m.includes('fetch failed');
    }

    /**
     * Completes one turn, trying providers in order until one answers.
     * @returns {{ text, toolCalls, usage, provider, model }}
     */
    async complete({ messages, tools, onProviderSwitch = null }) {
        const usable = this.availableProviders;
        if (usable.length === 0) {
            throw new Error('No AI provider is configured. Set GEMINI_API_KEY or GROQ_API_KEY.');
        }

        const errors = [];
        let attempted = 0;

        for (const provider of usable) {
            if (this.isOpen(provider.name)) {
                errors.push(`${provider.name}: circuit open`);
                continue;
            }

            attempted++;
            if (attempted > 1 && onProviderSwitch) {
                await onProviderSwitch(provider.name);
            }

            const start = Date.now();
            try {
                const result = await provider.complete({ messages, tools });
                this.recordSuccess(provider.name);
                return { ...result, latencyMs: Date.now() - start };
            } catch (err) {
                this.recordFailure(provider.name);
                errors.push(`${provider.name}: ${err.message}`);

                if (!ProviderRouter.isTransient(err)) {
                    // Same request, same failure everywhere — don't pretend otherwise.
                    throw err;
                }
            }
        }

        const e = new Error(`All providers failed. ${errors.join(' | ')}`);
        e.code = 'ALL_PROVIDERS_FAILED';
        throw e;
    }
}

export default new ProviderRouter();
