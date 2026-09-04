import { ToolRegistry, ConfirmationStore } from '../../src/agent/registry.mjs';
import { ok } from '../../src/providers/messages.mjs';
import { check, report } from './harness.mjs';

/**
 * An irreversible tool must never run without a confirmation the user gave on a
 * LATER turn. Otherwise a single hallucinated tool call destroys a repository, and
 * an agent that can confirm its own action inside one loop is no gate at all.
 */

let deletions = 0;

const registry = new ToolRegistry().register({
    name: 'delete_repository',
    description: 'Deletes a repository.',
    destructive: true,
    parameters: { type: 'object', properties: { repoName: { type: 'string' } }, required: ['repoName'] },
    handler: async ({ repoName }) => { deletions++; return ok({ deleted: repoName }); }
});

registry.register({
    name: 'list_repositories',
    description: 'Lists repositories.',
    parameters: { type: 'object', properties: {} },
    handler: async () => ok({ repositories: [] })
});

const store = new ConfirmationStore();
const USER = 'user-1';
const ARGS = { repoName: 'someone/important-repo' };
const ctx = () => ({ userId: USER, confirmations: store.forUser(USER) });

// The user sends their first message.
store.beginTurn(USER);

const r1 = await registry.execute('delete_repository', ARGS, ctx());
check('first call is blocked', !r1.ok && r1.error.code === 'CONFIRMATION_REQUIRED');
check('nothing was deleted', deletions === 0);
check('the blocked result names the target', JSON.stringify(r1).includes('important-repo'));

// Same turn: the agent must not be able to satisfy its own confirmation mid-loop.
const r2 = await registry.execute('delete_repository', ARGS, ctx());
check('a second call in the same turn is still blocked', !r2.ok && r2.error.code === 'CONFIRMATION_REQUIRED');
check('still nothing deleted', deletions === 0);

// The user replies, which advances the turn and makes the confirmation valid.
store.beginTurn(USER);
const r3 = await registry.execute('delete_repository', ARGS, ctx());
check('after the user confirms on a later turn, it runs', r3.ok === true);
check('exactly one deletion happened', deletions === 1);

// The confirmation is single-use.
store.beginTurn(USER);
const r4 = await registry.execute('delete_repository', ARGS, ctx());
check('the confirmation cannot be replayed', !r4.ok && r4.error.code === 'CONFIRMATION_REQUIRED');
check('no second deletion', deletions === 1);

// A confirmation for one repository must not authorise another. Uses a separate
// user so no confirmation is already outstanding from the checks above.
const USER2 = 'user-2';
const ctx2 = () => ({ userId: USER2, confirmations: store.forUser(USER2) });
store.beginTurn(USER2);
await registry.execute('delete_repository', ARGS, ctx2());          // raises for repo A
store.beginTurn(USER2);
const r5 = await registry.execute('delete_repository', { repoName: 'someone/other-repo' }, ctx2());
check('a confirmation does not transfer to a different target', !r5.ok && r5.error.code === 'CONFIRMATION_REQUIRED');
check('the other repository was not deleted', deletions === 1, { deletions });

// Non-destructive tools are unaffected.
const r6 = await registry.execute('list_repositories', {}, ctx());
check('non-destructive tools are not gated', r6.ok === true);

// Missing required arguments are rejected before any handler runs.
const r7 = await registry.execute('delete_repository', {}, ctx());
check('missing required arguments are rejected', !r7.ok && r7.error.code === 'BAD_ARGUMENTS');

report('destructive gate');
