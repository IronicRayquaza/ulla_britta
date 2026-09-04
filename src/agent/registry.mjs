import { ok, fail } from '../providers/messages.mjs';
import { AccessError } from './github-access.mjs';

/**
 * Tool registry.
 *
 * One place where a tool's schema and its implementation live together, so they
 * cannot drift apart — the old design declared 15 tools in one list and handled
 * them in a switch that also contained two tools nobody could ever call.
 *
 * Handlers return structured outcomes via ok()/fail(); anything they throw is
 * converted to a structured failure here.
 */
export class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }

    register(tool) {
        if (!tool.name || typeof tool.handler !== 'function') {
            throw new Error(`Invalid tool registration: ${JSON.stringify(tool?.name)}`);
        }
        if (this.tools.has(tool.name)) {
            throw new Error(`Duplicate tool: ${tool.name}`);
        }
        this.tools.set(tool.name, {
            parameters: { type: 'object', properties: {} },
            destructive: false,
            ...tool
        });
        return this;
    }

    get(name) { return this.tools.get(name); }
    list() { return [...this.tools.values()]; }

    /** Provider-neutral schemas, without handlers. */
    specs() {
        return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
    }

    /** Checks required parameters before a handler runs. */
    static validate(tool, args) {
        const required = tool.parameters?.required || [];
        const missing = required.filter(k => args?.[k] === undefined || args[k] === null || args[k] === '');
        return missing.length ? `Missing required argument(s): ${missing.join(', ')}.` : null;
    }

    /**
     * Executes a tool and always returns a structured result.
     * @param {object} context - { userId, logger, confirmations, ... }
     */
    async execute(name, args = {}, context = {}) {
        const tool = this.tools.get(name);
        if (!tool) {
            return fail('UNKNOWN_TOOL', `There is no tool called "${name}".`, {
                hint: `Available tools: ${[...this.tools.keys()].join(', ')}`
            });
        }

        if (args.__malformed_arguments !== undefined) {
            return fail('BAD_ARGUMENTS', 'The arguments were not valid JSON.', { retryable: true });
        }

        const invalid = ToolRegistry.validate(tool, args);
        if (invalid) return fail('BAD_ARGUMENTS', invalid, { retryable: true });

        // Irreversible actions need an explicit confirmation raised on an earlier
        // user turn. Enforced here so no prompt wording can talk past it.
        if (tool.destructive && context.confirmations) {
            if (!context.confirmations.consume(name, args)) {
                context.confirmations.request(name, args);
                return fail(
                    'CONFIRMATION_REQUIRED',
                    `"${name}" is irreversible and was NOT executed.`,
                    {
                        hint: `Tell the user exactly what would be affected (${JSON.stringify(args)}) `
                            + `and ask them to confirm. Do not call this tool again until they have.`
                    }
                );
            }
        }

        try {
            const result = await tool.handler(args, context);
            // Handlers should return ok()/fail(); wrap a bare value defensively.
            if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
            return ok(result);
        } catch (err) {
            if (err instanceof AccessError) {
                return fail(err.code, err.message, { retryable: false });
            }
            const status = err?.status;
            if (status === 403 || status === 401) {
                return fail('FORBIDDEN', `GitHub refused that: ${err.message}`, { retryable: false });
            }
            if (status === 404) {
                return fail('NOT_FOUND', err.message, { retryable: false });
            }
            if (status === 429 || status >= 500) {
                return fail('UPSTREAM_ERROR', err.message, { retryable: true });
            }
            return fail('TOOL_ERROR', err.message || String(err), { retryable: false });
        }
    }
}

/**
 * Per-user store for pending destructive-action confirmations.
 *
 * A confirmation is valid only if it was raised on an EARLIER turn, so the agent
 * cannot request and satisfy its own confirmation inside a single loop.
 */
export class ConfirmationStore {
    constructor(ttlMs = 5 * 60 * 1000) {
        this.ttlMs = ttlMs;
        this.pending = new Map();  // userId -> { name, args, at, turn }
        this.turns = new Map();    // userId -> turn counter
    }

    beginTurn(userId) {
        const next = (this.turns.get(userId) || 0) + 1;
        this.turns.set(userId, next);
        return next;
    }

    /** A view bound to one user, which is what the registry receives. */
    forUser(userId) {
        return {
            request: (name, args) => this.pending.set(userId, {
                name, args, at: Date.now(), turn: this.turns.get(userId) || 0
            }),
            consume: (name, args) => {
                const p = this.pending.get(userId);
                if (!p) return false;
                const matches = p.name === name
                    && JSON.stringify(p.args) === JSON.stringify(args)
                    && Date.now() - p.at < this.ttlMs
                    && p.turn < (this.turns.get(userId) || 0);
                if (matches) this.pending.delete(userId);
                return matches;
            },
            peek: () => this.pending.get(userId) || null
        };
    }
}

export default ToolRegistry;
