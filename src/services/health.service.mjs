/**
 * Repository health from measured signals.
 *
 * The previous version was a string template whose verdict was
 * `issues.length > 10 ? 'Needs Attention' : 'Healthy'`, emailed as a "Health
 * Report". This measures things that can actually be checked and states which
 * signals it could not read, instead of scoring an absence of data as good.
 */

const DAY = 24 * 60 * 60 * 1000;
const daysSince = (date) => Math.floor((Date.now() - new Date(date).getTime()) / DAY);

/** CI pass rate over recent workflow runs on the default branch. */
async function ciHealth(client, owner, repo, branch) {
    try {
        const { data } = await client.rest.actions.listWorkflowRunsForRepo({
            owner, repo, branch, per_page: 30, status: 'completed'
        });
        const runs = data.workflow_runs || [];
        if (runs.length === 0) return { available: true, configured: false };

        const passed = runs.filter(r => r.conclusion === 'success').length;
        return {
            available: true,
            configured: true,
            sampled: runs.length,
            passRate: Math.round((passed / runs.length) * 100),
            lastRun: runs[0]?.created_at,
            lastConclusion: runs[0]?.conclusion
        };
    } catch {
        // Actions may be disabled, or the installation may lack the permission.
        return { available: false };
    }
}

/** Whether the repository has anything that looks like a test setup. */
async function testSignals(client, owner, repo) {
    try {
        const { data } = await client.rest.repos.getContent({ owner, repo, path: '' });
        const names = Array.isArray(data) ? data.map(f => f.name) : [];

        const hasTestDir = names.some(n => ['test', 'tests', '__tests__', 'spec', 'e2e'].includes(n));
        let hasTestScript = false;

        if (names.includes('package.json')) {
            try {
                const { data: pkgFile } = await client.rest.repos.getContent({ owner, repo, path: 'package.json' });
                const pkg = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf8'));
                const script = pkg.scripts?.test || '';
                // The npm default counts as no tests, not as tests.
                hasTestScript = Boolean(script) && !/no test specified/i.test(script);
            } catch { /* unreadable package.json */ }
        }

        return { available: true, hasTestDir, hasTestScript, hasCI: names.includes('.github') };
    } catch {
        return { available: false };
    }
}

/** Age distribution of open issues and pull requests. */
async function backlog(client, owner, repo) {
    try {
        const issues = await client.paginate(client.rest.issues.listForRepo, {
            owner, repo, state: 'open', per_page: 100
        }, (res, done) => {
            if (res.data.length < 100) done();
            return res.data;
        });

        const realIssues = issues.filter(i => !i.pull_request);
        const pulls = issues.filter(i => i.pull_request);
        const stale = (items) => items.filter(i => daysSince(i.updated_at) > 30).length;

        return {
            available: true,
            openIssues: realIssues.length,
            staleIssues: stale(realIssues),
            openPRs: pulls.length,
            stalePRs: stale(pulls),
            oldestPRDays: pulls.length ? Math.max(...pulls.map(p => daysSince(p.created_at))) : 0
        };
    } catch {
        return { available: false };
    }
}

/**
 * Collects health signals. Returns findings and explicit gaps — never a score that
 * treats missing data as a pass.
 */
export async function checkRepoHealth(client, owner, repo) {
    const { data: repoData } = await client.rest.repos.get({ owner, repo });
    const branch = repoData.default_branch;

    const [ci, tests, work] = await Promise.all([
        ciHealth(client, owner, repo, branch),
        testSignals(client, owner, repo),
        backlog(client, owner, repo)
    ]);

    const findings = [];
    const unknown = [];

    if (!ci.available) unknown.push('CI history (Actions not readable)');
    else if (!ci.configured) findings.push({ level: 'warn', text: 'No completed workflow runs — CI does not appear to be set up.' });
    else if (ci.passRate < 70) findings.push({ level: 'bad', text: `CI passes only ${ci.passRate}% of the last ${ci.sampled} runs on ${branch}.` });
    else if (ci.lastConclusion !== 'success') findings.push({ level: 'warn', text: `The most recent CI run on ${branch} did not succeed (${ci.lastConclusion}).` });

    if (!tests.available) unknown.push('test setup (repository contents not readable)');
    else if (!tests.hasTestDir && !tests.hasTestScript) findings.push({ level: 'warn', text: 'No test directory and no usable test script.' });

    if (!work.available) unknown.push('issue and PR backlog');
    else {
        if (work.stalePRs > 0) findings.push({ level: 'warn', text: `${work.stalePRs} of ${work.openPRs} open pull requests have had no activity for over 30 days.` });
        if (work.staleIssues > 10) findings.push({ level: 'warn', text: `${work.staleIssues} open issues have been inactive for over 30 days.` });
        if (work.oldestPRDays > 90) findings.push({ level: 'warn', text: `The oldest open pull request is ${work.oldestPRDays} days old.` });
    }

    const lastPush = daysSince(repoData.pushed_at);
    if (lastPush > 180) findings.push({ level: 'warn', text: `No commits for ${lastPush} days.` });
    if (!repoData.description) findings.push({ level: 'info', text: 'The repository has no description.' });
    if (repoData.archived) findings.push({ level: 'info', text: 'This repository is archived.' });

    return {
        repository: `${owner}/${repo}`,
        defaultBranch: branch,
        lastPushDays: lastPush,
        signals: { ci, tests, backlog: work },
        findings,
        // Named explicitly so an unreadable signal is never mistaken for a clean one.
        couldNotCheck: unknown
    };
}

export function formatHealthReport(health) {
    const lines = [`### Health: ${health.repository}`, ''];

    const { ci, tests, backlog: work } = health.signals;

    lines.push('**Measured:**');
    lines.push(`- Last commit: ${health.lastPushDays} day(s) ago`);
    if (ci.available && ci.configured) {
        lines.push(`- CI: ${ci.passRate}% of the last ${ci.sampled} runs passed on ${health.defaultBranch}`);
    }
    if (tests.available) {
        lines.push(`- Tests: ${tests.hasTestScript ? 'test script present' : 'no test script'}, ${tests.hasTestDir ? 'test directory present' : 'no test directory'}`);
    }
    if (work.available) {
        lines.push(`- Open: ${work.openIssues} issue(s), ${work.openPRs} pull request(s) (${work.stalePRs} stale)`);
    }

    if (health.findings.length) {
        lines.push('', '**Findings:**');
        const icon = { bad: '🔴', warn: '🟡', info: '⚪' };
        for (const f of health.findings) lines.push(`- ${icon[f.level]} ${f.text}`);
    } else {
        lines.push('', 'No problems found in the signals that could be read.');
    }

    if (health.couldNotCheck.length) {
        lines.push('', `_Could not check: ${health.couldNotCheck.join(', ')}. Those are unknown, not clean._`);
    }

    return lines.join('\n');
}
