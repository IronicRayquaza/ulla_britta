import { GoogleGenerativeAI } from '@google/generative-ai';
import { randomUUID } from 'crypto';

/**
 * Gemini adapter.
 *
 * Deliberately stateless: we own the conversation history and hand the whole thing
 * over on every call. The old implementation used SDK chat sessions held in process
 * memory, which vanished on restart and could not be handed to another provider.
 */
export class GeminiProvider {
    constructor({ apiKey, model = 'gemini-2.5-flash', name = 'gemini' } = {}) {
        // The router runs two Gemini tiers off one key, so the name is settable:
        // it keys the circuit breaker, and two tiers must trip independently.
        this.name = name;
        this.model = model;
        this.apiKey = apiKey || null;
        this.client = apiKey ? new GoogleGenerativeAI(apiKey) : null;
    }

    get available() {
        return this.client !== null;
    }

    /**
     * Model ids this key can actually reach.
     * Used by the boot-time preflight, which exists because a hardcoded model
     * name silently stopped existing and took every fallback run with it.
     */
    async listModels({ timeoutMs = 5000 } = {}) {
        if (!this.apiKey) return [];
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`,
            { signal: AbortSignal.timeout(timeoutMs) }
        );
        if (!res.ok) throw new Error(`Gemini model list returned ${res.status}`);
        const body = await res.json();
        return (body.models || []).map(m => String(m.name).replace(/^models\//, ''));
    }

    /**
     * Gemini's function schema is a subset of JSON Schema, and it rejects an
     * OBJECT with no properties outright:
     *   "parameters.properties: should be non-empty for OBJECT type"
     * A tool that takes no arguments is perfectly ordinary, so the whole request
     * would fail because of one such tool. Empty objects are dropped instead.
     */
    static sanitizeSchema(schema) {
        if (!schema || typeof schema !== 'object') return schema;

        if (schema.type === 'array') {
            const items = GeminiProvider.sanitizeSchema(schema.items);
            return items ? { ...schema, items } : null;
        }

        if (schema.type !== 'object') return schema;

        const properties = {};
        for (const [key, value] of Object.entries(schema.properties || {})) {
            const cleaned = GeminiProvider.sanitizeSchema(value);
            if (cleaned) properties[key] = cleaned;
        }

        if (Object.keys(properties).length === 0) return null;

        // A required key whose property was dropped would be unsatisfiable.
        const required = (schema.required || []).filter(k => properties[k]);
        return { ...schema, properties, ...(required.length ? { required } : {}) };
    }

    /** Normalized tools → Gemini functionDeclarations. */
    static toolsFor(tools) {
        if (!tools || tools.length === 0) return undefined;
        return [{
            functionDeclarations: tools.map(t => {
                const parameters = GeminiProvider.sanitizeSchema(t.parameters);
                return {
                    name: t.name,
                    description: t.description,
                    // Omitted entirely for a tool that takes no arguments.
                    ...(parameters && { parameters })
                };
            })
        }];
    }

    /** Normalized messages → Gemini { systemInstruction, contents }. */
    static contentsFor(messages) {
        const systemParts = [];
        const contents = [];

        for (const m of messages) {
            if (m.role === 'system') {
                systemParts.push(m.content);
                continue;
            }

            if (m.role === 'user') {
                contents.push({ role: 'user', parts: [{ text: m.content }] });
                continue;
            }

            if (m.role === 'assistant') {
                const parts = [];
                if (m.content) parts.push({ text: m.content });
                for (const c of m.toolCalls || []) {
                    parts.push({ functionCall: { name: c.name, args: c.args || {} } });
                }
                // Gemini rejects empty parts; an assistant turn always has something.
                if (parts.length === 0) parts.push({ text: '' });
                contents.push({ role: 'model', parts });
                continue;
            }

            if (m.role === 'tool') {
                let response;
                try {
                    response = JSON.parse(m.content);
                } catch {
                    response = { result: m.content };
                }
                contents.push({
                    role: 'user',
                    parts: [{ functionResponse: { name: m.name, response } }]
                });
            }
        }

        return {
            systemInstruction: systemParts.length ? systemParts.join('\n\n') : undefined,
            contents
        };
    }

    async complete({ messages, tools, model }) {
        if (!this.client) throw new Error('Gemini is not configured (missing GEMINI_API_KEY).');

        const { systemInstruction, contents } = GeminiProvider.contentsFor(messages);
        const generativeModel = this.client.getGenerativeModel({
            model: model || this.model,
            ...(systemInstruction && { systemInstruction }),
            ...(GeminiProvider.toolsFor(tools) && { tools: GeminiProvider.toolsFor(tools) })
        });

        // Without a timeout a struggling model can hold a step open for minutes —
        // a 503 from an overloaded Gemini took 2m15s to surface before the run
        // could even try the next provider. Failing over sooner is worth more than
        // waiting out an outage.
        const result = await generativeModel.generateContent(
            { contents },
            { timeout: Number(process.env.PROVIDER_TIMEOUT_MS) || 60_000 }
        );
        const response = result.response;

        const calls = (typeof response.functionCalls === 'function' ? response.functionCalls() : null) || [];
        let text = '';
        try {
            text = response.text() || '';
        } catch {
            // response.text() throws when the turn contains only function calls.
            text = '';
        }

        return {
            text,
            toolCalls: calls.map(c => ({ id: randomUUID(), name: c.name, args: c.args || {} })),
            usage: {
                inputTokens: response.usageMetadata?.promptTokenCount || 0,
                outputTokens: response.usageMetadata?.candidatesTokenCount || 0
            },
            provider: this.name,
            model: model || this.model
        };
    }
}

export default GeminiProvider;
