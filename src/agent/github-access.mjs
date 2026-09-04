import githubService from '../services/github.service.mjs';
import databaseService from '../services/database.service.mjs';

/**
 * The single place a GitHub client is obtained for agent work.
 *
 * Previously each tool handler resolved its own client from the repo owner via
 * getClientForOrg(), using app-level credentials. That bypassed the caller's
 * identity entirely: any user could act on any repository the App happened to be
 * installed on, in any account. Every tool now goes through here, and access is
 * always resolved from the acting user.
 */

export class AccessError extends Error {
    constructor(message, code = 'NO_ACCESS') {
        super(message);
        this.code = code;
    }
}

/** Splits "owner/repo", tolerating a bare repo name only when it is unambiguous. */
export function parseRepo(repoFullName) {
    if (!repoFullName || typeof repoFullName !== 'string') {
        throw new AccessError('A repository name is required, in "owner/repo" form.', 'BAD_REPO_NAME');
    }
    const parts = repoFullName.trim().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new AccessError(
            `"${repoFullName}" is not a full repository name. Use "owner/repo".`,
            'BAD_REPO_NAME'
        );
    }
    return { owner: parts[0], repo: parts[1] };
}

/**
 * Resolves an installation client for `userId`, scoped to `repoFullName` when given.
 * Throws AccessError when this user has no installation covering it.
 */
export async function resolveClient(userId, repoFullName = '') {
    if (!userId) throw new AccessError('No user context — cannot resolve GitHub access.', 'NO_USER');

    const installationId = await databaseService.getInstallationIdByRepo(repoFullName || '', userId);
    if (!installationId) {
        throw new AccessError(
            repoFullName
                ? `You have no GitHub App installation that covers "${repoFullName}". Install Ulla Britta on that account, or pick a repository you own.`
                : 'You have not connected a GitHub account yet. Finish onboarding to install the GitHub App.',
            'NO_INSTALLATION'
        );
    }

    return { client: await githubService.getClient(installationId), installationId };
}

/**
 * Confirms the installation actually has this repository, so a client resolved by
 * a user-level fallback cannot be pointed at somebody else's repo.
 */
export async function assertRepoAccess(client, owner, repo) {
    try {
        await client.rest.repos.get({ owner, repo });
    } catch (e) {
        if (e.status === 404) {
            throw new AccessError(
                `"${owner}/${repo}" is not visible to your installation. It may not exist, or the App may not be granted access to it.`,
                'REPO_NOT_ACCESSIBLE'
            );
        }
        throw e;
    }
}

/** Resolves a client and verifies repo access in one step. */
export async function clientForRepo(userId, repoFullName) {
    const { owner, repo } = parseRepo(repoFullName);
    const { client, installationId } = await resolveClient(userId, repoFullName);
    await assertRepoAccess(client, owner, repo);
    return { client, installationId, owner, repo };
}
