/**
 * Human phrasing for what the agent is doing, and the evidence that it did it.
 *
 * The dashboard used to show raw tool names and a JSON argument dump, so watching
 * a run told you almost nothing about what was actually happening. Each tool now
 * says what it is about to do in plain language, and reports what it found with
 * the concrete details — file paths, counts, names, links — that let you check the
 * work rather than take it on trust.
 *
 * This is deliberately deterministic string-building, not a second model call:
 * narration should never cost a request, never fail, and never invent anything the
 * tool result does not contain.
 */

const truncate = (s, n = 70) =>
    typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A file ending in a newline has not got an extra empty line on the end, so the
// trailing one is dropped before counting.
const lineCount = (text) =>
    typeof text === 'string' && text.length > 0
        ? text.replace(/\r?\n$/, '').split('\n').length
        : 0;

/**
 * Each entry may define:
 *   start(args)         what the agent is about to do, present tense
 *   done(args, data)    what it found or changed, past tense
 *   evidence(args,data) short strings that prove it — paths, names, links
 */
const narrators = {
    list_repositories: {
        start: () => 'Checking which repositories I can reach',
        done: (_a, d) => `Found ${plural(d.count, 'repository', 'repositories')}`,
        evidence: (_a, d) => (d.repositories || []).slice(0, 8).map(r => r.name)
    },

    get_readme: {
        start: (a) => `Reading the README of ${a.repoName}`,
        done: (a, d) => `Read the README of ${a.repoName} (${plural(lineCount(d.readme), 'line')})`,
        evidence: (_a, d) => firstLines(d.readme, 3)
    },

    get_file: {
        start: (a) => `Opening ${a.path} in ${a.repoName}`,
        done: (a, d) => `Read ${a.path} (${plural(lineCount(d.content), 'line')})`,
        evidence: (_a, d) => firstLines(d.content, 4)
    },

    search_repositories: {
        start: (a) => `Searching GitHub for ${a.topic || a.keyword || 'repositories'}`,
        done: (_a, d) => `Found ${plural(d.count, 'match', 'matches')}`,
        evidence: (_a, d) => (d.results || []).slice(0, 6).map(r => `${r.full_name} — ${r.stars}★`)
    },

    list_pull_requests: {
        start: (a) => `Listing ${a.state === 'closed' ? 'closed' : 'open'} pull requests on ${a.repoName}`,
        done: (a, d) => d.count === 0
            ? `No open pull requests on ${a.repoName}`
            : `Found ${plural(d.count, 'pull request')} on ${a.repoName}`,
        evidence: (_a, d) => (d.pullRequests || []).slice(0, 8)
            .map(pr => `#${pr.number} ${truncate(pr.title, 50)} — by ${pr.author}`)
    },

    get_pull_request: {
        start: (a) => `Reading pull request #${a.prNumber} on ${a.repoName}`,
        done: (a, d) => `Read #${a.prNumber}: ${truncate(d.title, 50)} — `
            + `${plural(d.changedFiles || 0, 'file')} changed, `
            + `${d.checks?.failing?.length ? `${plural(d.checks.failing.length, 'check')} failing` : 'checks passing'}`,
        evidence: (_a, d) => [
            ...(d.files || []).slice(0, 6).map(f => `${f.filename} (+${f.additions} −${f.deletions})`),
            ...(d.checks?.failing || []).slice(0, 3).map(c => `failing: ${c.name}`),
            d.mergeableState === 'dirty' ? 'has merge conflicts' : null
        ].filter(Boolean)
    },

    review_pull_request: {
        start: (a) => `Reviewing pull request #${a.prNumber} on ${a.repoName}`,
        done: (a, d) => d.posted
            ? `Posted a review on #${a.prNumber} with ${plural(d.inlineComments, 'inline comment')}`
            : `Did not review #${a.prNumber}: ${d.reason}`,
        evidence: (_a, d) => [
            ...(d.filesReviewed || []).slice(0, 6).map(f => `reviewed ${f}`),
            ...(d.filesSkipped || []).slice(0, 3).map(f => `skipped ${f.filename} (${f.reason})`),
            d.url || null
        ].filter(Boolean)
    },

    get_check_failures: {
        start: (a) => `Checking why CI failed on ${a.ref}`,
        done: (_a, d) => d.failing?.length
            ? `${plural(d.failing.length, 'check')} failing`
            : 'No failing checks',
        evidence: (_a, d) => (d.failing || []).flatMap(f => [
            `${f.name} — ${f.conclusion}`,
            ...(f.annotations || []).slice(0, 3).map(an => `  ${an.path}:${an.line} ${truncate(an.message, 60)}`)
        ]).slice(0, 8)
    },

    fix_pull_request: {
        start: (a) => `Working out a fix for pull request #${a.prNumber} on ${a.repoName}`,
        done: (a, d) => d.applied
            ? `Pushed a fix to #${a.prNumber} (${plural(d.filesChanged.length, 'file')} changed)`
            : `No fix pushed to #${a.prNumber}: ${d.reason}`,
        evidence: (_a, d) => [
            ...(d.filesChanged || []).map(f => `changed ${f}`),
            ...(d.rejected || []).map(f => `refused to touch ${f} — not part of this PR`),
            d.explanation ? truncate(d.explanation, 120) : null
        ].filter(Boolean)
    },

    check_dependencies: {
        start: (a) => `Comparing the dependencies of ${a.repoName} against the npm registry`,
        done: (_a, d) => {
            const resolved = d.checked - (d.unresolved?.length || 0);
            if (resolved === 0) return 'Could not resolve any packages on the registry';
            const majors = (d.outdated || []).filter(o => o.drift === 'major').length;
            return `Checked ${plural(d.checked, 'package')}: `
                + `${d.outdated?.length || 0} outdated (${majors} a major behind)`
                + `${d.vulnerable?.length ? `, ${plural(d.vulnerable.length, 'with a known advisory')}` : ''}`;
        },
        evidence: (_a, d) => [
            ...(d.outdated || []).slice(0, 6).map(o => `${o.name} ${o.declared} → ${o.latest} (${o.drift})`),
            ...(d.vulnerable || []).slice(0, 3).map(v => `advisory: ${v.name} (${v.advisories.length})`)
        ]
    },

    check_repo_health: {
        start: (a) => `Measuring the health of ${a.repoName}`,
        done: (_a, d) => d.findings?.length
            ? `${plural(d.findings.length, 'finding')} on ${d.repository}`
            : `Nothing concerning in the signals I could read for ${d.repository}`,
        evidence: (_a, d) => [
            ...(d.findings || []).slice(0, 6).map(f => f.text),
            d.couldNotCheck?.length ? `could not check: ${d.couldNotCheck.join(', ')}` : null
        ].filter(Boolean)
    },

    push_file: {
        start: (a) => `Writing ${a.path} to ${a.repoName}`,
        done: (a) => `Committed ${a.path} to ${a.repoName}`,
        evidence: (a) => [`commit message: ${truncate(a.commitMessage, 60)}`, `${plural(lineCount(a.content), 'line')} written`]
    },

    create_repository: {
        start: (a) => `Creating the repository ${a.name}`,
        done: (_a, d) => `Created ${d.repository}${d.files?.length ? ` with ${plural(d.files.length, 'file')}` : ' (empty)'}`,
        evidence: (_a, d) => [...(d.files || []), d.url].filter(Boolean)
    },

    scaffold_repository: {
        start: (a) => `Scaffolding a new ${a.techStack} project`,
        done: (_a, d) => `Created ${d.repository} with ${plural(d.filesCreated?.length || 0, 'file')}`,
        evidence: (_a, d) => [...(d.filesCreated || []).slice(0, 8), d.url].filter(Boolean)
    },

    get_repository: {
        start: (a) => `Looking up ${a.repoName}`,
        done: (_a, d) => `${d.name}: ${d.language || 'no primary language'}, ${plural(d.stars || 0, 'star')}, `
            + `${plural(d.open_issues || 0, 'open issue')}, default branch ${d.default_branch}`,
        evidence: (_a, d) => [d.description, d.private ? 'private' : 'public', d.url].filter(Boolean)
    },

    list_directory: {
        start: (a) => `Listing ${a.path || 'the root'} of ${a.repoName}`,
        done: (a, d) => `${plural(d.count, 'entry', 'entries')} in ${d.path}`,
        evidence: (_a, d) => (d.entries || []).slice(0, 10).map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`)
    },

    get_repository_tree: {
        start: (a) => `Reading the file tree of ${a.repoName}`,
        done: (_a, d) => `${plural(d.totalFiles, 'file')} in ${d.repository} at ${d.ref}`,
        evidence: (_a, d) => (d.paths || []).slice(0, 10)
    },

    push_files: {
        start: (a) => `Committing ${plural(a.files?.length || 0, 'file')} to ${a.repoName}`,
        done: (_a, d) => `Committed ${plural(d.files?.length || 0, 'file')} as ${d.sha?.slice(0, 7)} on ${d.branch}`,
        evidence: (_a, d) => (d.files || []).slice(0, 8)
    },

    delete_file: {
        start: (a) => `Deleting ${a.path} from ${a.repoName}`,
        done: (a) => `Deleted ${a.path} from ${a.repoName}`
    },

    search_code: {
        start: (a) => `Searching code for "${truncate(a.query, 40)}"`,
        done: (_a, d) => `${plural(d.total, 'match', 'matches')}, showing ${d.count}`,
        evidence: (_a, d) => (d.results || []).slice(0, 8).map(r => `${r.repository}: ${r.path}`)
    },

    list_branches: {
        start: (a) => `Listing the branches of ${a.repoName}`,
        done: (_a, d) => `${plural(d.count, 'branch', 'branches')}, default is ${d.defaultBranch}`,
        evidence: (_a, d) => (d.branches || []).slice(0, 10).map(b => b.name + (b.protected ? ' (protected)' : ''))
    },

    create_branch: {
        start: (a) => `Creating the branch ${a.branch} in ${a.repoName}`,
        done: (_a, d) => `Created ${d.branch} from ${d.from}`
    },

    list_commits: {
        start: (a) => `Reading the commit history of ${a.repoName}`,
        done: (_a, d) => `${plural(d.count, 'commit')}`,
        evidence: (_a, d) => (d.commits || []).slice(0, 8).map(c => `${c.sha} ${truncate(c.message, 55)}`)
    },

    get_commit: {
        start: (a) => `Reading commit ${String(a.sha).slice(0, 7)} in ${a.repoName}`,
        done: (_a, d) => `${d.sha}: ${truncate(d.message, 50)} — `
            + `${plural(d.files?.length || 0, 'file')} changed (+${d.stats?.additions || 0} −${d.stats?.deletions || 0})`,
        evidence: (_a, d) => (d.files || []).slice(0, 6).map(f => `${f.status} ${f.path}`)
    },

    compare_branches: {
        start: (a) => `Comparing ${a.base}…${a.head} in ${a.repoName}`,
        done: (_a, d) => `${d.head} is ${d.aheadBy} ahead and ${d.behindBy} behind ${d.base}`,
        evidence: (_a, d) => (d.files || []).slice(0, 8).map(f => `${f.path} (+${f.additions} −${f.deletions})`)
    },

    list_issues: {
        start: (a) => `Listing ${a.state === 'closed' ? 'closed' : 'open'} issues on ${a.repoName}`,
        done: (a, d) => d.count === 0
            ? `No ${d.state} issues on ${d.repository}`
            : `${plural(d.count, 'issue')} on ${d.repository}`,
        evidence: (_a, d) => (d.issues || []).slice(0, 8).map(i => `#${i.number} ${truncate(i.title, 50)}`)
    },

    get_issue: {
        start: (a) => `Reading issue #${a.issueNumber} on ${a.repoName}`,
        done: (_a, d) => `#${d.number} ${truncate(d.title, 45)} — ${d.state}, ${plural(d.comments || 0, 'comment')}`,
        evidence: (_a, d) => [
            d.labels?.length ? `labels: ${d.labels.join(', ')}` : null,
            d.assignees?.length ? `assigned to ${d.assignees.join(', ')}` : null,
            ...firstLines(d.body, 2)
        ].filter(Boolean)
    },

    create_issue: {
        start: (a) => `Opening an issue on ${a.repoName}: ${truncate(a.title, 45)}`,
        done: (_a, d) => `Opened #${d.number} on ${d.repository}`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    update_issue: {
        start: (a) => `Updating #${a.issueNumber} on ${a.repoName}`,
        done: (_a, d) => `Updated #${d.number} (${(d.changed || []).join(', ')}) — now ${d.state}`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    comment_on_issue: {
        start: (a) => `Commenting on ${a.repoName}#${a.issueNumber}`,
        done: (_a, d) => `Posted a comment on ${d.repository}#${d.issueNumber}`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    search_issues: {
        start: (a) => `Searching GitHub for ${truncate(a.query, 50)}`,
        done: (_a, d) => `${plural(d.total, 'match', 'matches')}, showing ${d.count}`,
        evidence: (_a, d) => (d.results || []).slice(0, 8)
            .map(i => `${i.repository}#${i.number} ${truncate(i.title, 40)} (${i.state})`)
    },

    create_pull_request: {
        start: (a) => `Opening a pull request from ${a.head} on ${a.repoName}`,
        done: (_a, d) => `Opened #${d.number}: ${truncate(d.title, 45)} (${d.head} → ${d.base})`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    merge_pull_request: {
        start: (a) => `Merging ${a.repoName}#${a.prNumber}`,
        done: (_a, d) => d.merged
            ? `Merged #${d.prNumber} into its base as ${d.sha?.slice(0, 7)} (${d.method})`
            : `#${d.prNumber} was not merged`,
        evidence: (_a, d) => [d.message].filter(Boolean)
    },

    list_pull_request_files: {
        start: (a) => `Listing the files changed by ${a.repoName}#${a.prNumber}`,
        done: (_a, d) => `${plural(d.count, 'file')} changed in #${d.prNumber}`,
        evidence: (_a, d) => (d.files || []).slice(0, 8).map(f => `${f.path} (+${f.additions} −${f.deletions})`)
    },

    list_pull_request_reviews: {
        start: (a) => `Checking the reviews on ${a.repoName}#${a.prNumber}`,
        done: (_a, d) => d.count === 0
            ? `No reviews yet on #${d.prNumber}`
            : `${plural(d.count, 'review')} on #${d.prNumber}`,
        evidence: (_a, d) => [
            ...(d.reviews || []).slice(0, 6).map(r => `${r.reviewer}: ${r.state}`),
            d.requestedReviewers?.length ? `waiting on ${d.requestedReviewers.join(', ')}` : null
        ].filter(Boolean)
    },

    submit_pull_request_review: {
        start: (a) => `Submitting a ${a.event} review on ${a.repoName}#${a.prNumber}`,
        done: (_a, d) => `Submitted a ${d.event} review on #${d.prNumber}`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    list_workflows: {
        start: (a) => `Listing the workflows in ${a.repoName}`,
        done: (_a, d) => `${plural(d.count, 'workflow')}`,
        evidence: (_a, d) => (d.workflows || []).slice(0, 8).map(w => `${w.name} (${w.path})`)
    },

    list_workflow_runs: {
        start: (a) => `Checking recent CI runs on ${a.repoName}`,
        done: (_a, d) => d.failing
            ? `${plural(d.count, 'run')}, ${d.failing} of them failing`
            : `${plural(d.count, 'run')}, none failing`,
        evidence: (_a, d) => (d.runs || []).slice(0, 6)
            .map(r => `${r.name} on ${r.branch} — ${r.conclusion || r.status}`)
    },

    get_workflow_run: {
        start: (a) => `Reading workflow run ${a.runId} on ${a.repoName}`,
        done: (_a, d) => `Run ${d.runId} (${d.name}) — ${d.conclusion || d.status}`,
        evidence: (_a, d) => (d.failures || []).flatMap(f => [
            `failed job: ${f.name}`,
            ...(f.failedSteps || []).map(s => `  step: ${s}`)
        ]).slice(0, 8)
    },

    get_workflow_run_logs: {
        start: (a) => `Reading the log of run ${a.runId} on ${a.repoName}`,
        done: (_a, d) => `Read the log of "${d.job}" (${d.conclusion})`,
        evidence: (_a, d) => [
            ...(d.failedSteps || []).map(s => `failed step: ${s}`),
            ...lastLines(d.log, 3)
        ]
    },

    rerun_workflow: {
        start: (a) => `Re-running workflow run ${a.runId} on ${a.repoName}`,
        done: (_a, d) => `Queued a rerun of run ${d.runId}${d.failedOnly ? ' (failed jobs only)' : ''}`,
        evidence: () => ['the result is not known yet']
    },

    dispatch_workflow: {
        start: (a) => `Triggering ${a.workflow} on ${a.repoName}`,
        done: (_a, d) => `Dispatched ${d.workflow} on ${d.ref}`,
        evidence: () => ['the run was queued; its result is not known yet']
    },

    list_releases: {
        start: (a) => `Listing the releases of ${a.repoName}`,
        done: (_a, d) => `${plural(d.count, 'release')}`,
        evidence: (_a, d) => (d.releases || []).slice(0, 6).map(r => `${r.tag} — ${r.name || 'untitled'}`)
    },

    get_latest_release: {
        start: (a) => `Looking up the latest release of ${a.repoName}`,
        done: (_a, d) => `Latest release is ${d.tag}${d.name ? ` (${d.name})` : ''}`,
        evidence: (_a, d) => firstLines(d.notes, 3)
    },

    create_release: {
        start: (a) => `Publishing release ${a.tag} on ${a.repoName}`,
        done: (_a, d) => `Published ${d.tag}${d.draft ? ' as a draft' : ''}${d.prerelease ? ' (pre-release)' : ''}`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    get_user_profile: {
        start: (a) => a.username ? `Looking up @${a.username}` : 'Looking up your GitHub profile',
        done: (_a, d) => `@${d.login}${d.name ? ` (${d.name})` : ''} — `
            + `${plural(d.followers, 'follower')}, following ${d.following}, ${plural(d.publicRepos, 'public repo')}`,
        evidence: (_a, d) => [d.bio, d.company, d.location, d.url].filter(Boolean)
    },

    list_followers: {
        start: (a) => a.username ? `Listing @${a.username}'s followers` : 'Listing your followers',
        done: (_a, d) => `@${d.username} has ${plural(d.total, 'follower')}; showing ${d.count}`,
        evidence: (_a, d) => (d.followers || []).slice(0, 10)
    },

    list_following: {
        start: (a) => a.username ? `Listing who @${a.username} follows` : 'Listing who you follow',
        done: (_a, d) => `@${d.username} follows ${plural(d.total, 'account')}; showing ${d.count}`,
        evidence: (_a, d) => (d.following || []).slice(0, 10)
    },

    list_notifications: {
        start: () => 'Reading your GitHub notifications',
        done: (_a, d) => `${plural(d.count, 'notification')}`,
        evidence: (_a, d) => (d.notifications || []).slice(0, 8)
            .map(n => `${n.repository}: ${truncate(n.title, 45)} (${n.reason})`)
    },

    list_security_alerts: {
        start: (a) => `Reading the security alerts on ${a.repoName}`,
        done: (_a, d) => d.totalOpen === 0
            ? (d.couldNotRead?.length ? 'No alerts I could read — and some sources were unavailable' : 'No open security alerts')
            : `${plural(d.totalOpen, 'open alert')}`,
        evidence: (_a, d) => [
            ...(d.dependabot || []).slice(0, 5).map(a => `${a.severity}: ${a.package} — ${truncate(a.summary, 50)}`),
            ...(d.codeScanning || []).slice(0, 3).map(a => `${a.severity}: ${a.rule} at ${a.path}:${a.line}`),
            ...(d.couldNotRead || []).map(x => `could not read: ${x}`)
        ]
    },

    fork_repository: {
        start: (a) => `Forking ${a.repoName}`,
        done: (_a, d) => `Forked ${d.forked} into ${d.into}`,
        evidence: (_a, d) => [d.url].filter(Boolean)
    },

    star_repository: {
        start: (a) => `Starring ${a.repoName}`,
        done: (a) => `Starred ${a.repoName}`
    },

    build_feature: {
        start: (a) => `Filing a build request on ${a.repoName}`,
        done: (a, d) => `Opened issue #${d.issueNumber} on ${a.repoName} — the build runs in the background`,
        evidence: (_a, d) => [d.url, 'no code has been written yet'].filter(Boolean)
    },

    generate_changelog: {
        start: (a) => `Reading recent commits on ${a.repoName}`,
        done: (_a, d) => `Wrote a changelog from ${plural(d.commits, 'commit')}`,
        evidence: (_a, d) => [d.range ? `range ${d.range}` : null].filter(Boolean)
    },

    flag_stale_issues: {
        start: (a) => `Looking for stale issues on ${a.repoName}`,
        done: (_a, d) => d.dryRun
            ? `${plural(d.stale, 'issue')} would be flagged`
            : `Flagged ${d.flagged} of ${plural(d.stale, 'stale issue')}`,
        evidence: (_a, d) => (d.issues || []).slice(0, 8).map(i =>
            typeof i === 'object' ? `#${i.number} ${truncate(i.title, 50)}` : `#${i}`)
    },

    send_email: {
        start: (a) => `Emailing you "${truncate(a.subject, 50)}"`,
        done: (a) => `Sent "${truncate(a.subject, 50)}" to your address`
    },

    delete_repository: {
        start: (a) => `Preparing to delete ${a.repoName}`,
        done: (_a, d) => `Deleted ${d.deleted}`,
        evidence: () => ['this cannot be undone']
    }
};

/** First few non-empty lines of a file, as proof of what was actually read. */
function firstLines(text, n) {
    if (typeof text !== 'string') return [];
    return text
        .split('\n')
        .filter(l => l.trim())
        .slice(0, n)
        .map(l => truncate(l.trim(), 80));
}

/** The tail of a log, which is where the failure is. */
function lastLines(text, n) {
    if (typeof text !== 'string') return [];
    const lines = text.split('\n').filter(l => l.trim());
    return lines.slice(-n).map(l => truncate(l.trim(), 100));
}

/** "get_pull_request" → "Get pull request" for a tool with no narrator. */
function humanise(name) {
    const words = String(name).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a tool without its own narrator did, read off the shape of its result.
 *
 * The tool surface is much larger than the set of hand-written narrators, and
 * "Add labels — done" tells a watcher nothing. This picks out the fields tools
 * actually return — counts, names, urls, and the flags that mean "it happened" —
 * so a new tool is legible on the day it is added rather than the day someone
 * remembers to write a narrator for it.
 */
function describeGenerically(toolName, args, data) {
    const subject = args?.repoName ? ` on ${args.repoName}` : '';

    if (typeof data?.count === 'number') {
        const noun = toolName.replace(/^list_/, '').replace(/_/g, ' ');
        return `Found ${plural(data.count, noun.replace(/s$/, ''), noun)}${subject}`;
    }

    // Tools report what they did with a boolean named after the verb.
    const verbs = ['created', 'updated', 'deleted', 'merged', 'posted', 'committed',
        'removed', 'cancelled', 'dispatched', 'starred', 'sent', 'ready', 'rerun'];
    const verb = verbs.find(v => data?.[v] === true);
    if (verb) return `${humanise(toolName)} — ${verb}${subject}`;

    return `${humanise(toolName)} — done`;
}

/** Concrete details from an arbitrary result: names, paths, links, counts. */
function evidenceGenerically(data) {
    if (!data || typeof data !== 'object') return [];

    const out = [];
    for (const value of Object.values(data)) {
        if (Array.isArray(value) && value.length) {
            out.push(...value.slice(0, 6).map(v => {
                if (typeof v === 'string') return truncate(v, 80);
                if (v && typeof v === 'object') {
                    const name = v.name || v.login || v.path || v.title || v.tag || v.full_name;
                    return name ? truncate(String(name), 80) : null;
                }
                return null;
            }).filter(Boolean));
        }
        if (out.length >= 8) break;
    }

    if (typeof data.url === 'string') out.push(data.url);
    if (typeof data.note === 'string') out.push(truncate(data.note, 120));
    return out.slice(0, 8);
}

/** What the agent is about to do. */
export function narrateStart(toolName, args = {}) {
    try {
        return narrators[toolName]?.start?.(args) || humanise(toolName);
    } catch {
        return humanise(toolName);
    }
}

/**
 * What happened, plus the evidence for it.
 * A failure reports the real reason rather than a generic "failed".
 */
export function narrateResult(toolName, args = {}, result = {}) {
    if (!result.ok) {
        return {
            summary: result.error?.message || 'That did not work',
            evidence: result.error?.hint ? [result.error.hint] : [],
            ok: false
        };
    }

    const narrator = narrators[toolName];
    const data = result.data ?? {};

    let summary;
    let evidence = [];
    try {
        summary = narrator?.done?.(args, data) || describeGenerically(toolName, args, data);
        evidence = (narrator?.evidence?.(args, data) || evidenceGenerically(data))
            .filter(Boolean).map(String);
    } catch {
        // A narrator that throws must never take the run with it.
        summary = describeGenerically(toolName, args, data);
        evidence = [];
    }

    // An action skipped because a previous attempt already applied it should say so
    // rather than looking like it ran again.
    if (data.alreadyApplied) {
        summary = `${summary} (already done earlier in this run, not repeated)`;
    }

    return { summary, evidence, ok: true };
}

export default { narrateStart, narrateResult };
