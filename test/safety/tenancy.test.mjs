import databaseService from '../../src/services/database.service.mjs';
import githubService from '../../src/services/github.service.mjs';
import crypto from 'crypto';
import { check, report } from './harness.mjs';

/**
 * Tenant isolation.
 *
 * The old resolver matched github_installations on account_login WITHOUT filtering
 * by user_id, then fell back to "any installation belonging to this user". Either
 * path could hand a caller a client for an account they had nothing to do with.
 */

/**
 * A stand-in for the installations table. Two users, two GitHub accounts.
 *   alice → acme      (installation 100)
 *   bob   → globex    (installation 200)
 */
const ROWS = [
    { user_id: 'alice', installation_id: 100, account_login: 'acme', installed_at: '2026-01-01' },
    { user_id: 'bob', installation_id: 200, account_login: 'globex', installed_at: '2026-01-02' }
];

function fakeSupabase() {
    return {
        from(table) {
            const state = { table, filters: {}, ilike: null, limitN: null };
            const api = {
                select: () => api,
                order: () => api,
                limit: (n) => { state.limitN = n; return api; },
                eq: (col, val) => { state.filters[col] = val; return api; },
                ilike: (col, val) => { state.ilike = [col, val]; return api; },
                maybeSingle: async () => {
                    let rows = ROWS;
                    for (const [col, val] of Object.entries(state.filters)) {
                        rows = rows.filter(r => r[col] === val);
                    }
                    if (state.ilike) {
                        const [col, val] = state.ilike;
                        rows = rows.filter(r => String(r[col]).toLowerCase() === String(val).toLowerCase());
                    }
                    return { data: rows[0] || null, error: null };
                }
            };
            return api;
        }
    };
}

const realClient = databaseService.client;
databaseService.client = fakeSupabase();

// ── Owner-scoped resolution ─────────────────────────────────────────────────
{
    check('a user resolves their own installation',
        await databaseService.getInstallationIdByRepo('acme/api', 'alice') === 100);

    check('the other user resolves theirs',
        await databaseService.getInstallationIdByRepo('globex/web', 'bob') === 200);

    // The heart of it: bob naming alice's repository must not reach alice's install.
    const crossTenant = await databaseService.getInstallationIdByRepo('acme/api', 'bob');
    check('a user cannot reach another tenant repository by name', crossTenant === null, crossTenant);

    const reverse = await databaseService.getInstallationIdByRepo('globex/web', 'alice');
    check('and not in the other direction either', reverse === null, reverse);
}

// ── No fallback to an unrelated installation ────────────────────────────────
{
    // alice HAS an installation, but not one covering "stranger". The old code fell
    // back to any installation she owned and returned 100 regardless.
    const unrelated = await databaseService.getInstallationIdByRepo('stranger/secret', 'alice');
    check('a named repository outside the user accounts does not fall back', unrelated === null, unrelated);

    // With no repository named, resolving the user's own installation is correct.
    check('an empty repository name resolves the user own installation',
        await databaseService.getInstallationIdByRepo('', 'alice') === 100);
}

// ── A missing user is refused outright ──────────────────────────────────────
{
    check('a lookup without a user is refused',
        await databaseService.getInstallationIdByRepo('acme/api', null) === null);
    check('an empty lookup without a user is refused',
        await databaseService.getInstallationIdByRepo('', undefined) === null);
}

// ── Case-insensitive owner matching still works within a tenant ─────────────
{
    check('owner matching is case-insensitive',
        await databaseService.getInstallationIdByRepo('ACME/api', 'alice') === 100);
}

databaseService.client = realClient;

// ── Webhook signatures are verified against raw bytes ───────────────────────
{
    const secret = 'test-secret';
    const previous = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = secret;

    // A body whose re-serialisation does NOT reproduce the original bytes: the
    // sender escaped a non-ASCII character as \u00e9 and included whitespace.
    // JSON.parse then JSON.stringify emits the literal character and drops the
    // spacing, so the HMAC over the re-serialised form no longer matches.
    const raw = Buffer.from('{"name": "caf\u00e9", "n": 1}', 'utf8');
    const sign = (buf) => 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');

    check('a correctly signed payload is accepted',
        githubService.verifySignature(raw, sign(raw)) === true);

    // This is the case the old implementation got wrong.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())), 'utf8');
    check('the re-serialised body differs from the raw bytes',
        !reserialised.equals(raw), { raw: raw.toString(), reserialised: reserialised.toString() });
    check('verifying the raw bytes still succeeds where re-serialising would fail',
        githubService.verifySignature(raw, sign(raw)) === true
        && githubService.verifySignature(reserialised, sign(raw)) === false);

    check('a tampered payload is rejected',
        githubService.verifySignature(Buffer.from('{"evil":true}'), sign(raw)) === false);
    check('a missing signature is rejected', githubService.verifySignature(raw, null) === false);
    check('a short signature is rejected without throwing',
        githubService.verifySignature(raw, 'sha256=abc') === false);

    process.env.GITHUB_WEBHOOK_SECRET = '';
    check('no configured secret rejects everything', githubService.verifySignature(raw, sign(raw)) === false);
    process.env.GITHUB_WEBHOOK_SECRET = previous;
}

report('tenant isolation');
