/**
 * Normalized message format.
 *
 * Every provider adapter converts to and from this shape, so a run that starts on
 * one provider can continue on another mid-loop with its full history intact. The
 * previous gateway lost all tool-call history when it failed over, which is why a
 * rate-limited run silently degraded into a chatbot.
 *
 *   { role: 'system',    content }
 *   { role: 'user',      content }
 *   { role: 'assistant', content, toolCalls: [{ id, name, args, meta? }] }
 *   { role: 'tool',      toolCallId, name, content }
 *
 * `meta` is opaque per-provider data that has to survive the round trip. Gemini 3
 * attaches a thought signature to every function call and rejects the next turn
 * with a 400 if the history comes back without it — so anything an adapter needs
 * to hand back verbatim lives here rather than being dropped on normalization.
 */

export const system = (content) => ({ role: 'system', content });
export const user = (content) => ({ role: 'user', content });

export const assistant = (content, toolCalls = []) => ({
    role: 'assistant',
    content: content || '',
    toolCalls
});

export const toolResult = (toolCallId, name, result) => ({
    role: 'tool',
    toolCallId,
    name,
    content: typeof result === 'string' ? result : JSON.stringify(result)
});

/**
 * Structured tool outcomes. Handlers return these rather than prose, so the model
 * can tell a failure from a success that happens to mention the word "error", and
 * so the loop knows whether retrying is worthwhile.
 */
export const ok = (data) => ({ ok: true, data });

export const fail = (code, message, { retryable = false, hint = null } = {}) => ({
    ok: false,
    error: { code, message, retryable, ...(hint && { hint }) }
});

/** Rough token estimate, used for budgeting when a provider reports no usage. */
export function estimateTokens(messages) {
    const text = messages.map(m => {
        const calls = (m.toolCalls || []).map(c => c.name + JSON.stringify(c.args)).join('');
        return (m.content || '') + calls;
    }).join('');
    return Math.ceil(text.length / 4);
}
