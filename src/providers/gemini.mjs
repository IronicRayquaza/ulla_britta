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
    constructor({ apiKey, model = 'gemini-2.5-flash' } = {}) {
        this.name = 'gemini';
        this.model = model;
        this.client = apiKey ? new GoogleGenerativeAI(apiKey) : null;
    }

    get available() {
        return this.client !== null;
    }

    /** Normalized tools → Gemini functionDeclarations. */
    static toolsFor(tools) {
        if (!tools || tools.length === 0) return undefined;
        return [{
            functionDeclarations: tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters || { type: 'object', properties: {} }
            }))
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

        const result = await generativeModel.generateContent({ contents });
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
