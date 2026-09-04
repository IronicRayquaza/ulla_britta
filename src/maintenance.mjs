import { enqueueTask } from './queue.mjs';
import githubService from './services/github.service.mjs';
import databaseService from './services/database.service.mjs';
import queue from './queue.mjs';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Scheduled maintenance sweep.
 *
 * This used to be a setInterval inside the web process, which on a free-tier
 * service that sleeps between requests effectively never fired. It is now a
 * standalone entry point (`npm run maintenance`) for a platform cron job.
 *
 * The old version also enqueued tasks carrying only a repository name, with no
 * installation id — so the worker skipped every one of them for missing context.
 * And it enqueued three tasks per repository per user with no limit at all.
 */

// Keep one sweep proportionate: the most recently active repositories are the ones
// worth reporting on, and an unbounded fan-out is how a free API tier gets burned.
const MAX_REPOS_PER_INSTALLATION = Number(process.env.MAINTENANCE_MAX_REPOS || 10);
const TASKS = ['update_dependencies', 'check_repo_health', 'clean_stale_issues'];

export async function runMaintenance() {
    const started = Date.now();
    console.log('⏰ Maintenance sweep starting...');

    if (!databaseService.client) {
        console.error('❌ No database configured; cannot enumerate installations.');
        return { installations: 0, enqueued: 0 };
    }

    const { data: installations, error } = await databaseService.client
        .from('github_installations')
        .select('installation_id, user_id, account_login')
        .eq('status', 'active');

    if (error) {
        console.error(`❌ Could not read installations: ${error.message}`);
        return { installations: 0, enqueued: 0, error: error.message };
    }

    let enqueued = 0;
    const problems = [];

    for (const installation of installations || []) {
        try {
            const client = await githubService.getClient(installation.installation_id);
            const repos = await githubService.listUserRepos(client);

            const recent = repos
                .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
                .slice(0, MAX_REPOS_PER_INSTALLATION);

            for (const repo of recent) {
                for (const type of TASKS) {
                    // Every task carries the installation and the user it belongs to,
                    // so the worker can resolve access and attribute the result.
                    await enqueueTask(type, {
                        repository: { full_name: repo.full_name },
                        installation: { id: installation.installation_id },
                        userId: installation.user_id
                    });
                    enqueued++;
                }
            }

            console.log(`  ${installation.account_login}: ${recent.length} repo(s) queued`);
        } catch (e) {
            problems.push(`${installation.account_login}: ${e.message}`);
            console.error(`  ${installation.account_login}: ${e.message}`);
        }
    }

    const summary = {
        installations: installations?.length || 0,
        enqueued,
        problems,
        durationMs: Date.now() - started
    };
    console.log(`✅ Maintenance sweep queued ${enqueued} task(s) across ${summary.installations} installation(s).`);
    return summary;
}

// Running this file directly performs one sweep and exits, which is what a cron job
// wants. Importing it does nothing on its own.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('maintenance.mjs');
if (invokedDirectly) {
    runMaintenance()
        .then(() => queue.client.quit())
        .then(() => process.exit(0))
        .catch(err => {
            console.error('❌ Maintenance sweep failed:', err.message);
            process.exit(1);
        });
}
