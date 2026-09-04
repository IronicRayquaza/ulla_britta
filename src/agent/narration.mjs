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
        start: (a) => `Scaffolding a new ${a.techStack} project`,
        done: (_a, d) => `Created ${d.repository} with ${plural(d.filesCreated.length, 'file')}`,
        evidence: (_a, d) => [...(d.filesCreated || []).slice(0, 8), d.url].filter(Boolean)
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

/** "get_pull_request" → "Get pull request" for a tool with no narrator. */
function humanise(name) {
    const words = String(name).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
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
        summary = narrator?.done?.(args, data) || `${humanise(toolName)} — done`;
        evidence = (narrator?.evidence?.(args, data) || []).filter(Boolean).map(String);
    } catch {
        summary = `${humanise(toolName)} — done`;
    }

    // An action skipped because a previous attempt already applied it should say so
    // rather than looking like it ran again.
    if (data.alreadyApplied) {
        summary = `${summary} (already done earlier in this run, not repeated)`;
    }

    return { summary, evidence, ok: true };
}

export default { narrateStart, narrateResult };
