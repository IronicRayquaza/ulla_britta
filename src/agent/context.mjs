import githubService from '../services/github.service.mjs';
import databaseService from '../services/database.service.mjs';
import * as githubOAuth from '../services/github-oauth.service.mjs';

/**
 * Builds the real context the agent starts a run with.
 *
 * The previous implementation passed rows from processed_deployments — a table of
 * deployment ids and statuses containing no repository names — while instructing the
 * model to "use these repos directly". The agent was told to pick a repository from
 * data that had none in it. This loads the actual repository inventory instead, and
 * degrades quietly when GitHub is unreachable rather than failing the whole run.
 *
 * It also resolves the GitHub account. That was previously attempted with
 * `client.rest.apps.getAuthenticatedInstallation()` inside a Promise.allSettled, so
 * the missing-method error was swallowed and every run started with
 * "GitHub account: not yet resolved" — leaving the agent unable to interpret a
 * bare repository name or answer anything about the user themselves.
 */
export async function gatherContext(userId) {
    const context = {
        repositories: [],
        githubAccount: null,
        accountType: null,
        repositorySelection: null,
        userAuth: { connected: false, configured: githubOAuth.isConfigured(), login: null },
        degraded: false
    };

    try {
        const install = await databaseService.getInstallationForUser(userId);
        if (!install) {
            context.degraded = true;
            return context;
        }

        // The account is recorded when the installation is linked; no API call needed.
        context.githubAccount = install.login;
        context.accountType = install.type;
        context.repositorySelection = install.repositorySelection;

        const client = await githubService.getClient(install.installationId);

        const [reposResult, userResult] = await Promise.allSettled([
            githubService.listUserRepos(client),
            githubOAuth.getValidToken(userId)
        ]);

        if (reposResult.status === 'fulfilled') {
            context.repositories = (reposResult.value || [])
                .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
        } else {
            context.degraded = true;
        }

        if (userResult.status === 'fulfilled' && userResult.value) {
            context.userAuth.connected = true;
            context.userAuth.login = userResult.value.login;
        }
    } catch {
        // A run should still be able to start — the agent can call list_repositories
        // itself once GitHub is reachable again.
        context.degraded = true;
    }

    return context;
}

export default gatherContext;
