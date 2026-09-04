import githubService from '../services/github.service.mjs';
import databaseService from '../services/database.service.mjs';

/**
 * Builds the real context the agent starts a run with.
 *
 * The previous implementation passed rows from processed_deployments — a table of
 * deployment ids and statuses containing no repository names — while instructing the
 * model to "use these repos directly". The agent was told to pick a repository from
 * data that had none in it. This loads the actual repository inventory instead, and
 * degrades quietly when GitHub is unreachable rather than failing the whole run.
 */
export async function gatherContext(userId) {
    const context = { repositories: [], githubAccount: null, degraded: false };

    try {
        const installationId = await databaseService.getInstallationIdByRepo('', userId);
        if (!installationId) {
            context.degraded = true;
            return context;
        }

        const client = await githubService.getClient(installationId);

        const [reposResult, installResult] = await Promise.allSettled([
            githubService.listUserRepos(client),
            client.rest.apps.getAuthenticatedInstallation()
        ]);

        if (reposResult.status === 'fulfilled') {
            context.repositories = (reposResult.value || [])
                .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
        } else {
            context.degraded = true;
        }

        if (installResult.status === 'fulfilled') {
            context.githubAccount = installResult.value.data.account?.login || null;
        }
    } catch {
        // A run should still be able to start — the agent can call list_repositories
        // itself once GitHub is reachable again.
        context.degraded = true;
    }

    return context;
}

export default gatherContext;
