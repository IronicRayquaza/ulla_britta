import { generateText } from './ai.service.mjs';
import { commentableLines, buildDiffContext } from './diff.mjs';

/**
 * Pull request operations.
 *
 * These replace the previous implementations, which described themselves as doing
 * more than they did: the "review" posted one issue comment while claiming inline
 * comments, and the conflict resolver never fetched a file — its prompt literally
 * told the model to assume a conflict existed and describe how it would look at it.
 *
 * Everything here reads real data and reports exactly what it did.
 */

/** Parses a JSON object or array out of a model response. */
function parseJson(raw, fallback) {
    const text = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/[[{][\s\S]*[\]}]/);
        if (!match) return fallback;
        try {
            return JSON.parse(match[0]);
        } catch {
            return fallback;
        }
    }
}

/**
 * Full picture of a pull request: metadata, changed files, real diff, mergeability
 * and check status.
 */
export async function getPullRequest(client, owner, repo, prNumber) {
    const { data: pr } = await client.rest.pulls.get({ owner, repo, pull_number: prNumber });

    const files = await client.paginate(client.rest.pulls.listFiles, {
        owner, repo, pull_number: prNumber, per_page: 100
    });

    let checks = { total: 0, failing: [] };
    try {
        const { data } = await client.rest.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 100 });
        checks = {
            total: data.total_count,
            failing: data.check_runs
                .filter(c => ['failure', 'timed_out', 'cancelled'].includes(c.conclusion))
                .map(c => ({ name: c.name, conclusion: c.conclusion, url: c.html_url, id: c.id }))
        };
    } catch {
        // Checks may not be readable on every installation; the rest is still useful.
    }

    return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.user?.login,
        state: pr.state,
        draft: pr.draft,
        head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name },
        base: { ref: pr.base.ref },
        // 'dirty' means conflicts; 'unknown' means GitHub is still computing it.
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        checks,
        files: files.map(f => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions
        })),
        url: pr.html_url,
        _rawFiles: files
    };
}

/**
 * Reviews a pull request and posts a real GitHub review with inline comments.
 *
 * Comments the model anchors to lines that are not in the diff would make GitHub
 * reject the entire review, so they are validated against the parsed patch and
 * moved into the review body instead of being dropped or causing a 422.
 */
export async function reviewPullRequest(client, owner, repo, prNumber, { event = 'COMMENT', generate = generateText } = {}) {
    const pr = await getPullRequest(client, owner, repo, prNumber);
    const { included, omitted, text: diffText } = buildDiffContext(pr._rawFiles);

    if (included.length === 0) {
        return {
            posted: false,
            reason: 'There is no reviewable source diff in this pull request.',
            omitted
        };
    }

    const prompt = `Review this pull request as a senior engineer. Be specific and concrete.

Repository: ${owner}/${repo}
Title: ${pr.title}
Description: ${pr.body || '(none)'}
Failing checks: ${pr.checks.failing.length ? pr.checks.failing.map(c => c.name).join(', ') : 'none'}

The diff below is annotated with the line numbers of the new file version. Only cite
those numbers.

${diffText}

Return ONLY JSON:
{
  "summary": "2-4 sentences on what this change does and whether it is safe to merge",
  "verdict": "approve" | "comment" | "request_changes",
  "comments": [
    { "path": "exact/file/path.js", "line": 42, "body": "What is wrong and what to do instead." }
  ]
}

Rules:
- Only comment on real problems: bugs, security issues, missing error handling,
  breaking changes. Do not comment on style preferences.
- "line" must be a line number shown in the diff for that file.
- If you found nothing worth flagging, return an empty comments array and say so in
  the summary. Do not invent findings.`;

    const raw = await generate(prompt);
    const review = parseJson(raw, { summary: '', verdict: 'comment', comments: [] });

    // Only lines present in the diff can carry an inline comment.
    const valid = new Map();
    for (const file of included) {
        valid.set(file.filename, commentableLines(file.patch).commentable);
    }

    const inline = [];
    const unanchored = [];

    for (const c of review.comments || []) {
        const lines = valid.get(c.path);
        if (lines && Number.isInteger(c.line) && lines.has(c.line)) {
            inline.push({ path: c.path, line: c.line, side: 'RIGHT', body: c.body });
        } else if (c.path && c.body) {
            unanchored.push(c);
        }
    }

    let body = `### Ulla Britta review\n\n${review.summary || 'No summary was produced.'}`;

    if (unanchored.length) {
        body += `\n\n**Notes that could not be anchored to a diff line:**\n`
            + unanchored.map(c => `- \`${c.path}\`${c.line ? ` (near line ${c.line})` : ''}: ${c.body}`).join('\n');
    }
    if (omitted.length) {
        body += `\n\n_Not reviewed: ${omitted.map(o => `\`${o.filename}\` (${o.reason})`).join(', ')}._`;
    }

    // request_changes and approve are deliberately not self-selected: a review that
    // blocks a merge should be a human decision unless explicitly asked for.
    const reviewEvent = event === 'COMMENT' ? 'COMMENT' : event;

    const { data: posted } = await client.rest.pulls.createReview({
        owner, repo, pull_number: prNumber,
        event: reviewEvent,
        body,
        comments: inline
    });

    return {
        posted: true,
        reviewId: posted.id,
        url: posted.html_url,
        verdict: review.verdict,
        summary: review.summary,
        inlineComments: inline.length,
        unanchoredNotes: unanchored.length,
        filesReviewed: included.map(f => f.filename),
        filesSkipped: omitted
    };
}

/**
 * The real reason CI failed: failing check runs plus their annotations, and the
 * tail of the job log where there is one.
 */
export async function getCheckFailures(client, owner, repo, ref) {
    const { data } = await client.rest.checks.listForRef({ owner, repo, ref, per_page: 100 });

    const failing = data.check_runs.filter(c =>
        ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion));

    if (failing.length === 0) {
        return { ref, failing: [], message: 'No failing checks on this commit.' };
    }

    const detailed = [];
    for (const check of failing) {
        const entry = {
            name: check.name,
            conclusion: check.conclusion,
            url: check.html_url,
            summary: check.output?.summary || null,
            annotations: []
        };

        try {
            const { data: annotations } = await client.rest.checks.listAnnotations({
                owner, repo, check_run_id: check.id, per_page: 20
            });
            entry.annotations = annotations.map(a => ({
                path: a.path,
                line: a.start_line,
                level: a.annotation_level,
                message: a.message
            }));
        } catch {
            // Annotations are not always available; the summary still is.
        }

        detailed.push(entry);
    }

    return { ref, failing: detailed };
}

/**
 * Proposes a fix for a pull request by reading the real files, generating full
 * replacements, and pushing them to the PR's own branch.
 *
 * Only ever touches files the PR already changed, and only on the PR's head branch,
 * so a bad suggestion cannot land on a default branch.
 */
export async function proposePullRequestFix(client, owner, repo, prNumber, instruction = null, { generate = generateText } = {}) {
    const pr = await getPullRequest(client, owner, repo, prNumber);

    if (pr.state !== 'open') {
        return { applied: false, reason: `Pull request #${prNumber} is ${pr.state}.` };
    }
    if (pr.head.repo && pr.head.repo !== `${owner}/${repo}`) {
        return {
            applied: false,
            reason: `#${prNumber} comes from the fork ${pr.head.repo}. Pushing to a fork's branch needs access this installation does not have.`
        };
    }

    const failures = await getCheckFailures(client, owner, repo, pr.head.sha).catch(() => ({ failing: [] }));
    const { text: diffText, included } = buildDiffContext(pr._rawFiles, 30_000);

    if (included.length === 0) {
        return { applied: false, reason: 'There is no reviewable source diff to work from.' };
    }

    // Read the current contents of the changed files from the PR branch.
    const contents = {};
    for (const file of included.slice(0, 6)) {
        try {
            const { data } = await client.rest.repos.getContent({
                owner, repo, path: file.filename, ref: pr.head.ref
            });
            if (!Array.isArray(data) && data.content) {
                contents[file.filename] = Buffer.from(data.content, 'base64').toString('utf8');
            }
        } catch {
            // Deleted or unreadable; it simply is not a candidate for a fix.
        }
    }

    if (Object.keys(contents).length === 0) {
        return { applied: false, reason: 'None of the changed files could be read from the PR branch.' };
    }

    const prompt = `Fix the problems in this pull request.

Repository: ${owner}/${repo}
PR: #${prNumber} — ${pr.title}
${instruction ? `What the user asked for: ${instruction}` : ''}

Failing checks:
${failures.failing.length
    ? failures.failing.map(f => `- ${f.name}: ${f.summary || ''}\n${f.annotations.map(a => `    ${a.path}:${a.line} ${a.message}`).join('\n')}`).join('\n')
    : '(none reported)'}

Diff:
${diffText}

Current file contents:
${Object.entries(contents).map(([p, c]) => `\n=== ${p} ===\n${c}`).join('\n')}

Return ONLY JSON:
{
  "explanation": "What was wrong and what you changed",
  "confident": true | false,
  "files": [ { "path": "exact/path.js", "content": "the COMPLETE new file content" } ]
}

Rules:
- Only include files you are actually changing, and give their complete content.
- Only touch files listed above.
- If you cannot determine a correct fix, set confident to false and return an empty
  files array. A wrong guess pushed to someone's branch is worse than no fix.`;

    const raw = await generate(prompt);
    const fix = parseJson(raw, { explanation: '', confident: false, files: [] });

    if (!fix.confident || !Array.isArray(fix.files) || fix.files.length === 0) {
        return {
            applied: false,
            reason: 'No confident fix could be determined.',
            explanation: fix.explanation || null
        };
    }

    // Never write a file the pull request did not already touch.
    const allowed = new Set(Object.keys(contents));
    const rejected = fix.files.filter(f => !allowed.has(f.path)).map(f => f.path);
    const toWrite = fix.files.filter(f => allowed.has(f.path) && typeof f.content === 'string' && f.content.length > 0);

    if (toWrite.length === 0) {
        return {
            applied: false,
            reason: 'The proposed fix only touched files outside this pull request.',
            rejected
        };
    }

    const written = [];
    for (const file of toWrite) {
        const { data: existing } = await client.rest.repos
            .getContent({ owner, repo, path: file.path, ref: pr.head.ref })
            .catch(() => ({ data: null }));

        await client.rest.repos.createOrUpdateFileContents({
            owner, repo,
            path: file.path,
            message: `Ulla Britta: ${fix.explanation.substring(0, 60)}`,
            content: Buffer.from(file.content).toString('base64'),
            sha: existing?.sha,
            branch: pr.head.ref
        });
        written.push(file.path);
    }

    const comment = `### Ulla Britta pushed a fix\n\n${fix.explanation}\n\n`
        + `**Changed:** ${written.map(p => `\`${p}\``).join(', ')}\n\n`
        + `_Pushed to \`${pr.head.ref}\`. This has **not been verified** — CI has not run against it yet. `
        + `Read the diff before merging._`;

    await client.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: comment });

    return {
        applied: true,
        branch: pr.head.ref,
        filesChanged: written,
        rejected,
        explanation: fix.explanation,
        note: 'The fix was pushed to the pull request branch. It has not been verified by CI yet.'
    };
}
