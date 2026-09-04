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
