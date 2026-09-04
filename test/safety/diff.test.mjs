import { commentableLines, annotatePatch, buildDiffContext } from '../../src/services/diff.mjs';
import { check, report } from './harness.mjs';

/**
 * GitHub rejects a review comment anchored to a line that is not in the diff, with
 * a 422 that loses the entire review. So the line map has to be exactly right.
 */

// A patch that adds, removes and keeps lines, across two hunks.
const patch = [
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',       // new line 1 (context)
    '-const b = 2;',       // removed; occupies no new-file line
    '+const b = 20;',      // new line 2 (added)
    '+const c = 30;',      // new line 3 (added)
    ' const d = 4;',       // new line 4 (context)
    ' const e = 5;',       // new line 5 (context)
    '@@ -20,3 +21,4 @@',
    ' function f() {',     // new line 21 (context)
    '+  return 1;',        // new line 22 (added)
    ' }',                  // new line 23 (context)
    ''
].join('\n');

{
    const { commentable, added } = commentableLines(patch);

    check('added lines are commentable', added.has(2) && added.has(3) && added.has(22));
    check('context lines are commentable', commentable.has(1) && commentable.has(4) && commentable.has(5));
    check('the second hunk starts at its stated line', commentable.has(21) && added.has(22) && commentable.has(23));
    check('a removed line does not consume a new-file line number', !added.has(1));
    check('lines outside the diff are not commentable', !commentable.has(10) && !commentable.has(50));
    check('removed lines are not offered as anchors', added.size === 3, [...added]);
}

{
    const annotated = annotatePatch(patch);
    const lines = annotated.split('\n');

    check('hunk headers are left intact', lines[0] === '@@ -1,4 +1,5 @@');
    check('added lines are numbered', lines.some(l => /^\s+2 \+const b = 20;$/.test(l)), lines[3]);
    check('removed lines carry no number', lines.some(l => /^\s+-const b = 2;$/.test(l)));
    check('numbering restarts at the second hunk', lines.some(l => /^\s+22 \+ {2}return 1;$/.test(l)),
        lines.filter(l => l.includes('return 1')));
}

{
    const files = [
        { filename: 'src/index.js', patch, additions: 3, deletions: 1 },
        { filename: 'package-lock.json', patch, additions: 5000, deletions: 4000 },
        { filename: 'dist/bundle.js', patch, additions: 10, deletions: 0 },
        { filename: 'assets/logo.png', patch: undefined, additions: 0, deletions: 0 },
        { filename: 'src/util.min.js', patch, additions: 1, deletions: 0 }
    ];

    const { included, omitted, text } = buildDiffContext(files);

    check('source files are reviewed', included.map(f => f.filename).includes('src/index.js'));
    check('lockfiles are skipped', omitted.some(o => o.filename === 'package-lock.json'));
    check('build output is skipped', omitted.some(o => o.filename === 'dist/bundle.js'));
    check('minified files are skipped', omitted.some(o => o.filename === 'src/util.min.js'));
    check('binary files are skipped with a reason',
        omitted.some(o => o.filename === 'assets/logo.png' && /binary/.test(o.reason)));
    check('only the source file makes it into the prompt', included.length === 1, included.map(f => f.filename));
    check('the prompt text carries the annotated diff', text.includes('src/index.js') && /\s2 \+const b = 20;/.test(text));
}

{
    // A diff larger than the budget must be reported as truncated, not silently cut.
    const big = { filename: 'src/big.js', patch: '@@ -1,1 +1,1 @@\n+' + 'x'.repeat(50_000), additions: 1, deletions: 0 };
    const small = { filename: 'src/small.js', patch, additions: 1, deletions: 0 };
    const { included, omitted } = buildDiffContext([big, small], 10_000);

    check('an oversized file is omitted rather than truncated mid-hunk', included.length === 0 || !included.includes(big));
    check('the omission is reported with a reason',
        omitted.some(o => /budget/.test(o.reason)), omitted);
}

{
    // An empty or missing patch must not throw.
    const { commentable } = commentableLines(undefined);
    check('a missing patch yields no anchors', commentable.size === 0);
    check('annotating a missing patch returns empty', annotatePatch(null) === '');
}

report('diff parsing');
