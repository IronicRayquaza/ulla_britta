import * as prService from '../../src/services/pr.service.mjs';
import { check, report } from './harness.mjs';

/**
 * The rails on PR work:
 *  - a review only anchors comments to lines that exist in the diff, so GitHub
 *    cannot reject the whole review with a 422
 *  - a fix only ever writes files the PR already changed, on the PR branch
 *  - when no confident fix exists, nothing is written and it says so
 */

const patch = [
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',      // 1
    '+const b = 2;',      // 2
    '+const c = 3;',      // 3
    ' module.exports = a;'// 4
].join('\n');

function fakeClient({ files, pr = {}, onReview = () => {}, onWrite = () => {}, onComment = () => {} }) {
    return {
        paginate: async (_fn, _opts) => files,
        rest: {
            pulls: {
                get: async () => ({
                    data: {
                        number: 7, title: 'Add b and c', body: '', user: { login: 'dev' },
                        state: 'open', draft: false,
                        head: { ref: 'feature/b', sha: 'abc123', repo: { full_name: 'acme/api' } },
                        base: { ref: 'main' },
                        mergeable: true, mergeable_state: 'clean',
                        additions: 2, deletions: 0, changed_files: files.length,
                        html_url: 'https://github.com/acme/api/pull/7',
                        ...pr
                    }
                }),
                listFiles: () => {},
                createReview: async (args) => { onReview(args); return { data: { id: 1, html_url: 'r' } }; }
            },
            checks: {
                listForRef: async () => ({ data: { total_count: 0, check_runs: [] } }),
                listAnnotations: async () => ({ data: [] })
            },
            repos: {
                getContent: async ({ path }) => {
                    if (path === 'src/index.js') {
                        return { data: { content: Buffer.from('const a = 1;\n').toString('base64'), sha: 'sha1' } };
                    }
                    const e = new Error('Not Found'); e.status = 404; throw e;
                },
                createOrUpdateFileContents: async (args) => { onWrite(args); return { data: {} }; }
            },
            issues: {
                createComment: async (args) => { onComment(args); return { data: {} }; }
            }
        }
    };
}

const sourceFiles = [{ filename: 'src/index.js', patch, additions: 2, deletions: 0, status: 'modified' }];
let generate;

// ── 1. Only in-diff lines become inline comments ────────────────────────────
{
    let review = null;
    const client = fakeClient({ files: sourceFiles, onReview: (a) => { review = a; } });

    // The model cites one valid line, one line outside the diff, and one wrong file.
    generate = async () => JSON.stringify({
        summary: 'Adds two constants.',
        verdict: 'comment',
        comments: [
            { path: 'src/index.js', line: 2, body: 'b is never used.' },
            { path: 'src/index.js', line: 999, body: 'This line does not exist in the diff.' },
            { path: 'src/other.js', line: 1, body: 'This file is not in the PR.' }
        ]
    });

    const result = await prService.reviewPullRequest(client, 'acme', 'api', 7, { generate });

    check('a review is posted', result.posted === true);
    check('only the in-diff comment is inline', review.comments.length === 1, review.comments);
    check('the inline comment targets the cited line', review.comments[0].line === 2);
    check('the inline comment targets the RIGHT side', review.comments[0].side === 'RIGHT');
    check('out-of-diff notes are kept, not dropped', result.unanchoredNotes === 2, result);
    check('out-of-diff notes appear in the review body', review.body.includes('does not exist in the diff'));
    check('the review does not self-approve', review.event === 'COMMENT', review.event);
    check('the reported inline count matches what was sent', result.inlineComments === review.comments.length);
}

// ── 2. Nothing to review is said, not faked ─────────────────────────────────
{
    const client = fakeClient({ files: [{ filename: 'yarn.lock', patch, additions: 900, deletions: 10 }] });
    let posted = false;
    client.rest.pulls.createReview = async () => { posted = true; return { data: {} }; };

    const result = await prService.reviewPullRequest(client, 'acme', 'api', 7, { generate });
    check('a lockfile-only PR is not reviewed', result.posted === false);
    check('no review is posted to GitHub', posted === false);
    check('the reason is stated', /no reviewable source diff/i.test(result.reason), result.reason);
}

// ── 3. A fix only writes files the PR already changed ───────────────────────
{
    const writes = [];
    const comments = [];
    const client = fakeClient({
        files: sourceFiles,
        onWrite: (a) => writes.push(a),
        onComment: (a) => comments.push(a)
    });

    generate = async () => JSON.stringify({
        explanation: 'Removed the unused constant.',
        confident: true,
        files: [
            { path: 'src/index.js', content: 'const a = 1;\nmodule.exports = a;\n' },
            { path: '.github/workflows/deploy.yml', content: 'malicious: true' },
            { path: 'src/secrets.js', content: 'export const KEY = 1;' }
        ]
    });

    const result = await prService.proposePullRequestFix(client, 'acme', 'api', 7, null, { generate });

    check('the fix is applied', result.applied === true);
    check('only the in-PR file is written', writes.length === 1, writes.map(w => w.path));
    check('the written file is the one the PR changed', writes[0].path === 'src/index.js');
    check('the write targets the PR branch, not the base', writes[0].branch === 'feature/b');
    check('files outside the PR are rejected', result.rejected.includes('.github/workflows/deploy.yml'));
    check('every out-of-scope file is rejected', result.rejected.length === 2, result.rejected);
    check('the PR is told what changed', comments.length === 1 && comments[0].body.includes('src/index.js'));
    check('the comment does not claim CI has passed', /not been verified/i.test(comments[0].body));
}

// ── 4. No confident fix means nothing is written ────────────────────────────
{
    const writes = [];
    const client = fakeClient({ files: sourceFiles, onWrite: (a) => writes.push(a) });

    generate = async () => JSON.stringify({
        explanation: 'The failure is in a file I cannot see.',
        confident: false,
        files: []
    });

    const result = await prService.proposePullRequestFix(client, 'acme', 'api', 7, null, { generate });

    check('an unconfident fix writes nothing', writes.length === 0);
    check('it reports that no fix was applied', result.applied === false);
    check('it explains why', /no confident fix/i.test(result.reason), result.reason);
    check('the explanation is passed through', result.explanation.includes('cannot see'));
}

// ── 5. A fork PR is refused rather than half-attempted ──────────────────────
{
    const writes = [];
    const client = fakeClient({
        files: sourceFiles,
        pr: { head: { ref: 'patch-1', sha: 'x', repo: { full_name: 'outsider/api' } } },
        onWrite: (a) => writes.push(a)
    });

    const result = await prService.proposePullRequestFix(client, 'acme', 'api', 7, null, { generate });
    check('a fork PR is not written to', writes.length === 0);
    check('the fork limitation is stated plainly', /fork/i.test(result.reason), result.reason);
}

// ── 6. A closed PR is left alone ────────────────────────────────────────────
{
    const writes = [];
    const client = fakeClient({ files: sourceFiles, pr: { state: 'closed' }, onWrite: (a) => writes.push(a) });
    const result = await prService.proposePullRequestFix(client, 'acme', 'api', 7, null, { generate });
    check('a closed PR is not modified', writes.length === 0 && result.applied === false);
}

report('pull request tooling');
