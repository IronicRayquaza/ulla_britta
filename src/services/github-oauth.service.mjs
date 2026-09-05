import { Octokit } from 'octokit';
import databaseService from './database.service.mjs';
import dotenv from 'dotenv';

dotenv.config();

/**
 * GitHub user-to-server tokens.
 *
 * The App's installation token is the right credential for repository work, but it
 * is not the user. GitHub refuses a whole class of endpoints to it:
 *
 *   POST /user/repos              create a repository on a personal account
 *   PUT  /user/starred/…          star as the user
 *   PUT  /user/following/…        follow as the user
 *   GET  /notifications           the user's notification inbox
 *   POST /gists                   create a gist owned by the user
 *
 * Those are ordinary things to ask an agent that runs your GitHub account to do,
 * and every one of them was either missing or failing with an opaque 403. This
 * module adds the identifying OAuth flow the same GitHub App already supports, so
 * the agent can act as the user when — and only when — the user has connected it.
 *
 * The flow is optional. With GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET unset, every
 * user-scoped tool fails with a clear instruction instead of a stack trace.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Refresh this far before actual expiry, so a long run does not expire mid-flight. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function isConfigured() {
    return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

/** Where the user goes to grant the agent their own GitHub identity. */
export function authorizeUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID,
        state
    });
    if (redirectUri) params.set('redirect_uri', redirectUri);
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(body) {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            ...body
        })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        throw new Error(data.error_description || data.error || `GitHub returned ${res.status}`);
    }
    if (!data.access_token) {
        throw new Error('GitHub did not return an access token.');
    }
    return data;
}

/** Converts GitHub's `expires_in` seconds into absolute timestamps we can store. */
function shapeToken(data, login = null) {
    const now = Date.now();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt: data.expires_in ? new Date(now + data.expires_in * 1000).toISOString() : null,
        refreshTokenExpiresAt: data.refresh_token_expires_in
            ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
            : null,
        scope: data.scope || null,
        login
    };
}

/** Exchanges the ?code= from the callback for a token, and records who it belongs to. */
export async function exchangeCode(userId, code, redirectUri = null) {
    if (!isConfigured()) {
        throw new Error('GitHub user authorization is not configured on this server.');
    }

    const data = await postToken({ code, ...(redirectUri && { redirect_uri: redirectUri }) });

    // Confirm the token works and learn the login before storing anything.
    const probe = new Octokit({ auth: data.access_token });
    const { data: me } = await probe.rest.users.getAuthenticated();

    const token = shapeToken(data, me.login);
    await databaseService.storeGithubUserToken(userId, token);
    return { login: me.login, expiresAt: token.expiresAt };
}

/**
 * The user's current token, refreshed if it is expiring.
 * Returns null when there is none, or when the refresh token has itself expired —
 * callers turn that into "reconnect your GitHub account", never into a silent skip.
 */
export async function getValidToken(userId) {
    const stored = await databaseService.getGithubUserToken(userId);
    if (!stored?.accessToken) return null;

    const expiring = stored.expiresAt
        && Date.parse(stored.expiresAt) - REFRESH_SKEW_MS < Date.now();

    if (!expiring) return stored;

    if (!stored.refreshToken || !isConfigured()) return null;
    if (stored.refreshTokenExpiresAt && Date.parse(stored.refreshTokenExpiresAt) < Date.now()) {
        return null;
    }

    try {
        const data = await postToken({
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken
        });
        const refreshed = shapeToken(data, stored.login);
        await databaseService.storeGithubUserToken(userId, refreshed);
        return refreshed;
    } catch (err) {
        console.warn(`⚠️ Could not refresh the GitHub user token for ${userId}: ${err.message}`);
        return null;
    }
}

/** An Octokit authenticated as the user, or null when they have not connected one. */
export async function userClient(userId) {
    const token = await getValidToken(userId);
    if (!token) return null;
    return { client: new Octokit({ auth: token.accessToken }), login: token.login };
}

export async function disconnect(userId) {
    await databaseService.deleteGithubUserToken(userId);
}

export default { isConfigured, authorizeUrl, exchangeCode, getValidToken, userClient, disconnect };
