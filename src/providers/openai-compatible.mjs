import OpenAI from 'openai';
import { randomUUID } from 'crypto';

/**
 * Adapter for OpenAI-compatible chat APIs (Groq, OpenRouter).
 *
 * Unlike the previous gateway, this preserves the full tool-call history, so a run
 * can fail over to Groq mid-loop and keep going rather than losing everything it
 * had already done.
 */
export class OpenAICompatibleProvider {
    constructor({ name, apiKey, baseURL, model }) {
        this.name = name;
        this.model = model;
        this.client = apiKey ? new OpenAI({ apiKey, baseURL }) : null;
    }

    get available() {
        return this.client !== null;
    }

    /**
     * Model ids this key can actually reach.
     * Groq removed `llama-3.3-70b-versatile` while it was still the hardcoded
     * default here; the preflight that calls this is what would have caught it.
     */
    async listModels({ timeoutMs = 5000 } = {}) {
        if (!this.client) return [];
        const page = await this.client.models.list({ timeout: timeoutMs });
        return (page.data || []).map(m => m.id);
    }

    /**
     * The per-request token budget this key actually gets, read from the rate
     * limit headers on a one-token request.
     *
     * A model can exist and still be unusable. Groq's free tier caps a request at
     * 8,000 tokens while this agent's tool schema alone is larger, so every call
     * to it fails with a 413 — the model list says nothing about that. Costs a
     * single token to find out.
     *
     * @returns {Promise<number|null>} tokens per minute, or null when unknown.
     */
    async probeTokenLimit({ timeoutMs = 5000 } = {}) {
        if (!this.client) return null;
        const res = await this.client.chat.completions
            .create({ model: this.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
                { timeout: timeoutMs })
            .withResponse();

        const limit = res.response?.headers?.get?.('x-ratelimit-limit-tokens');
        return limit ? Number(limit) : null;
    }

    static toolsFor(tools) {
        if (!tools || tools.length === 0) return undefined;
        return tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters || { type: 'object', properties: {} }
            }
        }));
    }

    static messagesFor(messages) {
        return messages.map(m => {
            if (m.role === 'assistant') {
                const out = { role: 'assistant', content: m.content || null };
                if (m.toolCalls?.length) {
                    out.tool_calls = m.toolCalls.map(c => ({
                        id: c.id,
                        type: 'function',
                        function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
                    }));
                }
                return out;
            }
            if (m.role === 'tool') {
                return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
            }
            return { role: m.role, content: m.content };
        });
    }

    async complete({ messages, tools, model }) {
        if (!this.client) throw new Error(`${this.name} is not configured.`);

        const payload = {
            model: model || this.model,
            messages: OpenAICompatibleProvider.messagesFor(messages),
            max_tokens: 4096
        };
        const converted = OpenAICompatibleProvider.toolsFor(tools);
        if (converted) {
            payload.tools = converted;
            payload.tool_choice = 'auto';
        }

        const completion = await this.client.chat.completions.create(payload);
        const msg = completion.choices[0].message;

        const toolCalls = (msg.tool_calls || []).map(c => {
            let args = {};
            try {
                args = JSON.parse(c.function.arguments || '{}');
            } catch {
                // A model can emit malformed JSON. Surface it as an argument the tool
                // will reject, rather than crashing the run.
                args = { __malformed_arguments: c.function.arguments };
            }
            return { id: c.id || randomUUID(), name: c.function.name, args };
        });

        return {
            text: msg.content || '',
            toolCalls,
            usage: {
                inputTokens: completion.usage?.prompt_tokens || 0,
                outputTokens: completion.usage?.completion_tokens || 0
            },
            provider: this.name,
            model: model || this.model
        };
    }
}

export default OpenAICompatibleProvider;
