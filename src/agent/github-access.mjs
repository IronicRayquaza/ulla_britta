import githubService from '../services/github.service.mjs';
import databaseService from '../services/database.service.mjs';
import * as githubOAuth from '../services/github-oauth.service.mjs';

/**
 * The single place a GitHub client is obtained for agent work.
 *
 * Previously each tool handler resolved its own client from the repo owner via
 * getClientForOrg(), using app-level credentials. That bypassed the caller's
 * identity entirely: any user could act on any repository the App happened to be
 * installed on, in any account. Every tool now goes through here, and access is
 * always resolved from the acting user.
 *
 * Two credentials exist, and they are not interchangeable:
 *
 *   installation token — repository work. Reading, writing, issues, PRs, Actions.
 *   user token         — things only the user can do: create a repository on a
 *                        personal account, star, follow, read notifications.
 *
 * A tool asks for what it needs. Nothing silently downgrades: when a user-scoped
 * action has no user token, it says so and says how to fix it.
 */

export class AccessError extends Error {
    constructor(message, code = 'NO_ACCESS', hint = null) {
        super(message);
        this.code = code;
        this.hint = hint;
    }
}

/** Cache of accessible repository names per installation, for name resolution. */
const repoIndexCache = new Map();   // installationId -> { at, names: string[] }
const REPO_INDEX_TTL_MS = 60_000;

export function clearRepoIndexCache() {
    repoIndexCache.clear();
}

/**
 * Splits "owner/repo".
 *
 * A bare name is NOT rejected here any more. The agent used to be handed
 * "glyph" by a user who meant their own repository and had to give up, because
 * every path demanded a fully-qualified name. Bare names are returned unqualified
 * and resolved against the installation by resolveRepoName().
 */
export function parseRepo(repoFullName) {
    if (!repoFullName || typeof repoFullName !== 'string') {
        throw new AccessError('A repository name is required, in "owner/repo" form.', 'BAD_REPO_NAME');
    }
    const parts = repoFullName.trim().replace(/^https?:\/\/github\.com\//i, '').split('/');
    if (parts.length === 1 && parts[0]) {
        return { owner: null, repo: parts[0], qualified: false };
    }
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new AccessError(
            `"${repoFullName}" is not a repository name I can read. Use "owner/repo".`,
            'BAD_REPO_NAME'
        );
    }
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, ''), qualified: true };
}

/**
 * The installation this user has, and which GitHub account it belongs to.
 *
 * The account identity used to be fetched with
 * `client.rest.apps.getAuthenticatedInstallation()`, which is not a method
 * Octokit has — repository creation died on it, and the run context silently
 * recorded "GitHub account: not yet resolved" on every single turn. It is read
 * from the installation record instead, which is written at install time.
 */
export async function resolveInstallation(userId, repoFullName = '') {
    if (!userId) throw new AccessError('No user context — cannot resolve GitHub access.', 'NO_USER');

    const install = await databaseService.getInstallationForUser(userId, repoFullName);
    if (install) return install;

    // Nothing covering that owner. Say what the user DOES have, so the agent can
    // suggest the right target instead of concluding the repository is missing.
    const others = await databaseService.listInstallationsForUser(userId);
    const owner = (repoFullName || '').split('/')[0];

    if (!others.length) {
        // An installation belongs to ONE dashboard login. Somebody who signed up
        // twice — a second email, a different sign-in method — lands here with the
        // app installed and no access, and the old message ("install Ulla Britta
        // on your account") sent them to reinstall something they already had.
        throw new AccessError(
            'This dashboard login has no GitHub App installation linked to it. '
            + 'If you installed Ulla Britta while signed in under a different dashboard account, '
            + 'sign in with that one — an installation belongs to a single login, not to your GitHub account.',
            'NO_INSTALLATION',
            'If this is the login you want to use, open Settings and connect GitHub: '
            + 'reinstalling while signed in here moves the installation to this login. '
            + 'Manage installations at https://github.com/settings/installations.'
        );
    }

    throw new AccessError(
        `None of your GitHub App installations cover "${owner}". `
        + `You have it installed on: ${others.map(o => o.login).join(', ')}.`,
        'NO_INSTALLATION',
        `Either use one of those accounts, or install the app on "${owner}".`
    );
}

/**
 * An installation-authenticated client, scoped to `repoFullName` when given.
 * @returns {{ client, installationId, account: { login, type, repositorySelection } }}
 */
export async function resolveClient(userId, repoFullName = '') {
    const install = await resolveInstallation(userId, repoFullName);
    return {
        client: await githubService.getClient(install.installationId),
        installationId: install.installationId,
        account: {
            login: install.login,
            type: install.type,
            repositorySelection: install.repositorySelection
        }
    };
}

/** Repository full names this installation can actually see, cached briefly. */
async function accessibleRepoNames(client, installationId) {
    const cached = repoIndexCache.get(installationId);
    if (cached && Date.now() - cached.at < REPO_INDEX_TTL_MS) return cached.names;

    let names = [];
    try {
        const repos = await githubService.listUserRepos(client);
        names = repos.map(r => r.full_name);
    } catch {
        names = [];   // an unreadable index must not break the call that needed it
    }
    repoIndexCache.set(installationId, { at: Date.now(), names });
    return names;
}

/**
 * Turns whatever the user said into a real "owner/repo" this installation can see.
 *
 * Handles: a full name, a bare name ("glyph"), a GitHub URL, and a name whose
 * case does not match. When it cannot be resolved, the error lists the candidates
 * rather than leaving the agent to guess that the repository does not exist —
 * which is exactly what happened when a user asked about "glyph".
 */
export async function resolveRepoName(userId, repoFullName) {
    const { owner, repo, qualified } = parseRepo(repoFullName);

    // A qualified name resolves against the installation for that owner.
    const lookupKey = qualified ? `${owner}/${repo}` : '';
    const { client, installationId, account } = await resolveClient(userId, lookupKey);

    if (qualified) return { client, installationId, account, owner, repo };

    // Bare name: the user's own account is the obvious reading, then anything the
    // installation can see whose repo part matches.
    const names = await accessibleRepoNames(client, installationId);
    const matches = names.filter(n => n.split('/')[1].toLowerCase() === repo.toLowerCase());

    if (matches.length === 1) {
        const [o, r] = matches[0].split('/');
        return { client, installationId, account, owner: o, repo: r };
    }

    if (matches.length > 1) {
        throw new AccessError(
            `"${repo}" is ambiguous — it matches ${matches.join(', ')}.`,
            'AMBIGUOUS_REPO_NAME',
            'Ask the user which one they mean, or call it again with the full owner/repo name.'
        );
    }

    // Nothing matched. Fall back to the user's own account so the caller gets a
    // precise 404 with the inventory attached, rather than a name-parse error.
    return { client, installationId, account, owner: account.login, repo };
}

/**
 * Confirms the installation actually has this repository, so a client resolved by
 * a user-level fallback cannot be pointed at somebody else's repo.
 *
 * On a miss it reports what the installation CAN see. "It's possible the
 * repository doesn't exist" was the agent's own guess before; now it knows.
 */
export async function assertRepoAccess(client, owner, repo, installationId = null) {
    try {
        const { data } = await client.rest.repos.get({ owner, repo });
        return data;
    } catch (e) {
        if (e.status === 404) {
            const names = installationId ? await accessibleRepoNames(client, installationId) : [];
            const near = names.filter(n => n.split('/')[1].toLowerCase().includes(repo.toLowerCase()));
            const inventory = near.length
                ? `Closest names I can see: ${near.slice(0, 5).join(', ')}.`
                : names.length
                    ? `I can currently see ${names.length} repositories, and that is not one of them: `
                      + `${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}.`
                    : 'I cannot see any repositories through this installation at all.';

            throw new AccessError(
                `"${owner}/${repo}" is not visible to your installation. `
                + `Either it does not exist, or the app was not granted access to it. ${inventory}`,
                'REPO_NOT_ACCESSIBLE',
                'If the repository does exist, grant the app access to it at '
                + 'https://github.com/settings/installations — the installation may be limited to selected repositories.'
            );
        }
        throw e;
    }
}

/** Resolves a client, resolves the name, and verifies access in one step. */
export async function clientForRepo(userId, repoFullName) {
    const { client, installationId, account, owner, repo } = await resolveRepoName(userId, repoFullName);
    await assertRepoAccess(client, owner, repo, installationId);
    return { client, installationId, account, owner, repo, fullName: `${owner}/${repo}` };
}

/**
 * A client authenticated as the user, for the endpoints GitHub refuses to an
 * installation token. Throws with instructions rather than returning null, so a
 * tool cannot quietly do nothing.
 */
export async function requireUserClient(userId, action = 'this action') {
    if (!userId) throw new AccessError('No user context — cannot resolve GitHub access.', 'NO_USER');

    if (!githubOAuth.isConfigured()) {
        throw new AccessError(
            `${action} has to be done as you, not as the app, and this server has no GitHub user authorization configured.`,
            'USER_AUTH_UNCONFIGURED',
            'The operator needs to set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, and enable '
            + '"Request user authorization (OAuth) during installation" on the GitHub App.'
        );
    }

    const resolved = await githubOAuth.userClient(userId);
    if (!resolved) {
        throw new AccessError(
            `${action} has to be done as you, and you have not authorized me to act as your GitHub user yet.`,
            'USER_AUTH_REQUIRED',
            'Tell the user to open Settings in the dashboard and click "Connect GitHub account", '
            + 'then ask them to repeat the request.'
        );
    }
    return resolved;
}

/** The user client when there is one, otherwise the installation client. */
export async function preferUserClient(userId, repoFullName = '') {
    try {
        const resolved = await githubOAuth.userClient(userId);
        if (resolved) return { ...resolved, asUser: true };
    } catch {
        // fall through to the installation client
    }
    const { client } = await resolveClient(userId, repoFullName);
    return { client, login: null, asUser: false };
}

export default {
    AccessError,
    parseRepo,
    resolveInstallation,
    resolveClient,
    resolveRepoName,
    assertRepoAccess,
    clientForRepo,
    requireUserClient,
    preferUserClient
};
