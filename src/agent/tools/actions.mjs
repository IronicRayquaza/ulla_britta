import { clientForRepo } from '../github-access.mjs';
import { ok, fail, str, num, enumOf, REPO, excerpt, collect, clampLimit } from './common.mjs';

/**
 * GitHub Actions: what workflows exist, what they did, and making them run again.
 *
 * The agent could previously see that CI failed but never read a log line, so
 * "why did the build break" always ended in guesswork about a check name.
 */

/** Pulls the failing steps out of a run's jobs, which is what anyone actually wants. */
function failingJobs(jobs) {
    return jobs
        .filter(j => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped')
        .map(j => ({
            name: j.name,
            conclusion: j.conclusion,
            url: j.html_url,
            failedSteps: (j.steps || [])
                .filter(s => s.conclusion === 'failure')
                .map(s => s.name)
        }));
}

export default [
    {
        name: 'list_workflows',
        description: 'Lists the GitHub Actions workflows defined in a repository and whether each is active.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO },
            required: ['repoName']
        },
        handler: async ({ repoName }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data } = await client.rest.actions.listRepoWorkflows({ owner, repo, per_page: 100 });
            return ok({
                repository: `${owner}/${repo}`,
                count: data.total_count,
                workflows: (data.workflows || []).map(w => ({
                    id: w.id, name: w.name, path: w.path, state: w.state
                }))
            });
        }
    },

    {
        name: 'list_workflow_runs',
        description: 'Lists recent workflow runs with their conclusions. Use this to answer "is CI passing" or to find the run that broke.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                workflow: str('Workflow file name or id to filter by, e.g. ci.yml'),
                branch: str('Only runs on this branch'),
                status: enumOf(['completed', 'in_progress', 'queued', 'failure', 'success'], 'Filter by status or conclusion'),
                limit: num('How many to return (default 15)')
            },
            required: ['repoName']
        },
        handler: async ({ repoName, workflow, branch, status, limit = 15 }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const params = {
                owner, repo,
                ...(branch && { branch }),
                ...(status && { status }),
                per_page: clampLimit(limit, 15)
            };

            const { data } = workflow
                ? await client.rest.actions.listWorkflowRuns({ ...params, workflow_id: workflow })
                : await client.rest.actions.listWorkflowRunsForRepo(params);

            const runs = data.workflow_runs || [];
            return ok({
                repository: `${owner}/${repo}`,
                count: runs.length,
                failing: runs.filter(r => r.conclusion === 'failure').length,
                runs: runs.map(r => ({
                    id: r.id,
                    name: r.name,
                    status: r.status,
                    conclusion: r.conclusion,
                    branch: r.head_branch,
                    event: r.event,
                    sha: r.head_sha?.slice(0, 7),
                    started: r.run_started_at,
                    url: r.html_url
                }))
            });
        }
    },

    {
        name: 'get_workflow_run',
        description: 'Reads one workflow run and its jobs, naming exactly which jobs and which steps failed.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, runId: num('Workflow run id') },
            required: ['repoName', 'runId']
        },
        handler: async ({ repoName, runId }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                const [{ data: run }, { data: jobsData }] = await Promise.all([
                    client.rest.actions.getWorkflowRun({ owner, repo, run_id: runId }),
                    client.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId, per_page: 50 })
                ]);
                const jobs = jobsData.jobs || [];
                return ok({
                    repository: `${owner}/${repo}`,
                    runId,
                    name: run.name,
                    status: run.status,
                    conclusion: run.conclusion,
                    branch: run.head_branch,
                    sha: run.head_sha,
                    event: run.event,
                    url: run.html_url,
                    jobs: jobs.map(j => ({ name: j.name, conclusion: j.conclusion })),
                    failures: failingJobs(jobs)
                });
            } catch (e) {
                if (e.status === 404) return fail('NOT_FOUND', `There is no workflow run ${runId} in ${owner}/${repo}.`);
                throw e;
            }
        }
    },

    {
        name: 'get_workflow_run_logs',
        description: 'Reads the actual log output of a failed workflow job. This is how you find the real error message instead of guessing from a check name. Returns the tail of the log, where failures appear.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                runId: num('Workflow run id'),
                jobName: str('Which job to read. Defaults to the first failed job.'),
                lines: num('How many trailing lines to return (default 120)')
            },
            required: ['repoName', 'runId']
        },
        handler: async ({ repoName, runId, jobName = null, lines = 120 }, { userId }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);

            const { data: jobsData } = await client.rest.actions.listJobsForWorkflowRun({
                owner, repo, run_id: runId, per_page: 50
            });
            const jobs = jobsData.jobs || [];
            if (!jobs.length) return fail('NOT_FOUND', `Workflow run ${runId} has no jobs.`);

            const job = jobName
                ? jobs.find(j => j.name === jobName || j.name.includes(jobName))
                : jobs.find(j => j.conclusion === 'failure') || jobs[0];

            if (!job) {
                return fail('NOT_FOUND', `No job matching "${jobName}" in run ${runId}. Jobs are: ${jobs.map(j => j.name).join(', ')}.`);
            }

            try {
                // Octokit follows the redirect and hands back the plain-text log.
                const res = await client.rest.actions.downloadJobLogsForWorkflowRun({
                    owner, repo, job_id: job.id
                });
                const text = typeof res.data === 'string' ? res.data : Buffer.from(res.data).toString('utf8');
                const tail = text.split('\n').slice(-Math.min(400, Math.max(10, Number(lines) || 120)));

                return ok({
                    repository: `${owner}/${repo}`,
                    runId,
                    job: job.name,
                    conclusion: job.conclusion,
                    failedSteps: (job.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name),
                    log: excerpt(tail.join('\n'), 8000)
                });
            } catch (e) {
                if (e.status === 410) {
                    return fail('EXPIRED', `The logs for run ${runId} have expired and are no longer downloadable.`);
                }
                if (e.status === 403) {
                    return fail('FORBIDDEN', 'The app does not have the Actions read permission needed to download logs.', {
                        hint: 'Grant the GitHub App "Actions: read" and reinstall it.'
                    });
                }
                throw e;
            }
        }
    },

    {
        name: 'rerun_workflow',
        sideEffecting: true,
        description: 'Runs a workflow run again, optionally only the jobs that failed. Use this after pushing a fix, or when a run failed for a transient reason.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                runId: num('Workflow run id'),
                failedOnly: { type: 'boolean', description: 'Rerun only the failed jobs (default false)' }
            },
            required: ['repoName', 'runId']
        },
        handler: async ({ repoName, runId, failedOnly = false }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                if (failedOnly) {
                    await client.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
                } else {
                    await client.rest.actions.reRunWorkflow({ owner, repo, run_id: runId });
                }
                await logger?.info(`Re-ran workflow run ${runId} in ${owner}/${repo}`);
                return ok({
                    repository: `${owner}/${repo}`, runId, rerun: true, failedOnly,
                    note: 'The rerun was queued. Its result is not known yet.'
                });
            } catch (e) {
                if (e.status === 403) {
                    return fail('FORBIDDEN', 'The app lacks the Actions write permission needed to rerun workflows.');
                }
                throw e;
            }
        }
    },

    {
        name: 'cancel_workflow_run',
        sideEffecting: true,
        description: 'Cancels a workflow run that is still in progress.',
        parameters: {
            type: 'object',
            properties: { repoName: REPO, runId: num('Workflow run id') },
            required: ['repoName', 'runId']
        },
        handler: async ({ repoName, runId }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            try {
                await client.rest.actions.cancelWorkflowRun({ owner, repo, run_id: runId });
            } catch (e) {
                if (e.status === 409) {
                    return fail('NOT_RUNNING', `Run ${runId} is not in progress, so there is nothing to cancel.`);
                }
                throw e;
            }
            await logger?.info(`Cancelled workflow run ${runId} in ${owner}/${repo}`);
            return ok({ repository: `${owner}/${repo}`, runId, cancelled: true });
        }
    },

    {
        name: 'dispatch_workflow',
        sideEffecting: true,
        description: 'Triggers a workflow manually. The workflow must declare a workflow_dispatch trigger in its YAML.',
        parameters: {
            type: 'object',
            properties: {
                repoName: REPO,
                workflow: str('Workflow file name, e.g. deploy.yml'),
                ref: str('Branch or tag to run it on. Defaults to the default branch.'),
                inputs: str('Inputs the workflow declares, as a JSON object string, e.g. {"environment":"staging"}')
            },
            required: ['repoName', 'workflow']
        },
        handler: async ({ repoName, workflow, ref = null, inputs = null }, { userId, logger }) => {
            const { client, owner, repo } = await clientForRepo(userId, repoName);
            const { data: meta } = await client.rest.repos.get({ owner, repo });
            const target = ref || meta.default_branch;

            // Accepted as a JSON string so the schema stays flat: a free-form object
            // property is rejected by Gemini and handled badly by the others.
            let parsedInputs = {};
            if (inputs) {
                if (typeof inputs === 'object') {
                    parsedInputs = inputs;
                } else {
                    try {
                        parsedInputs = JSON.parse(inputs);
                    } catch {
                        return fail('BAD_ARGUMENTS', `"inputs" must be a JSON object, and "${inputs}" is not one.`);
                    }
                }
            }

            try {
                await client.rest.actions.createWorkflowDispatch({
                    owner, repo, workflow_id: workflow, ref: target, inputs: parsedInputs
                });
            } catch (e) {
                if (e.status === 422) {
                    return fail('NO_DISPATCH_TRIGGER',
                        `"${workflow}" cannot be triggered manually — it does not declare a workflow_dispatch trigger, or an input was wrong: ${e.message}`);
                }
                if (e.status === 404) {
                    return fail('NOT_FOUND', `There is no workflow "${workflow}" in ${owner}/${repo}. Call list_workflows to see what exists.`);
                }
                throw e;
            }

            await logger?.info(`Dispatched ${workflow} on ${target} in ${owner}/${repo}`);
            return ok({
                repository: `${owner}/${repo}`, workflow, ref: target, dispatched: true,
                note: 'The run was queued. Call list_workflow_runs to see how it goes.'
            });
        }
    }
];
