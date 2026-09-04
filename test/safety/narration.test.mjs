import { narrateStart, narrateResult } from '../../src/agent/narration.mjs';
import { runAgent } from '../../src/agent/loop.mjs';
import { ToolRegistry } from '../../src/agent/registry.mjs';
import { ok, fail, system, user } from '../../src/providers/messages.mjs';
import { check, report } from './harness.mjs';

/**
 * Watching a run should tell you what the agent is doing and let you check it.
 *
 * The dashboard previously showed raw tool names and a JSON argument dump, and the
 * model's own explanation of what it was about to do was kept in history and never
 * displayed — so a run looked like a sequence of opaque calls.
 */

// ── Narration reads like a person describing their work ─────────────────────
{
    check('reading a file names the file and the repository',
        narrateStart('get_file', { repoName: 'acme/api', path: 'src/index.js' })
        === 'Opening src/index.js in acme/api',
        narrateStart('get_file', { repoName: 'acme/api', path: 'src/index.js' }));

    check('reviewing a PR names the PR',
        narrateStart('review_pull_request', { repoName: 'acme/api', prNumber: 7 })
        === 'Reviewing pull request #7 on acme/api');

    check('an unknown tool still reads as a sentence',
        narrateStart('some_new_tool', {}) === 'Some new tool');

    check('narration never throws on missing arguments',
        typeof narrateStart('get_file', {}) === 'string');
}

// ── Results carry the evidence, not just a status ───────────────────────────
{
    const listed = narrateResult('list_repositories', {}, ok({
        count: 3,
        repositories: [
            { name: 'acme/api' }, { name: 'acme/web' }, { name: 'acme/docs' }
        ]
    }));
    check('a listing says how many were found', listed.summary === 'Found 3 repositories', listed.summary);
    check('a listing shows the actual names', listed.evidence.includes('acme/api'), listed.evidence);

    const one = narrateResult('list_repositories', {}, ok({ count: 1, repositories: [{ name: 'a/b' }] }));
    check('counts are pluralised correctly', one.summary === 'Found 1 repository', one.summary);

    const read = narrateResult('get_file', { repoName: 'acme/api', path: 'src/a.js' },
        ok({ content: 'const a = 1;\n\nexport default a;\n' }));
    // 'const a = 1;\n\nexport default a;\n' is three lines, not four: the trailing
    // newline terminates the last line rather than starting an empty one.
    check('reading a file reports its size', /3 lines/.test(read.summary), read.summary);
    check('reading a file shows what was actually in it',
        read.evidence.some(e => e.includes('const a = 1;')), read.evidence);

    const pr = narrateResult('get_pull_request', { repoName: 'acme/api', prNumber: 7 }, ok({
        title: 'Add caching',
        changedFiles: 2,
        files: [{ filename: 'src/cache.js', additions: 40, deletions: 2 }],
        checks: { failing: [{ name: 'typecheck' }] },
        mergeableState: 'dirty'
    }));
    check('a PR summary states what is wrong with it', /1 check failing/.test(pr.summary), pr.summary);
    check('the changed files are listed as evidence',
        pr.evidence.some(e => e.includes('src/cache.js (+40 −2)')), pr.evidence);
    check('a merge conflict is surfaced',
        pr.evidence.includes('has merge conflicts'), pr.evidence);

    const deps = narrateResult('check_dependencies', { repoName: 'acme/api' }, ok({
        checked: 20,
        unresolved: [],
        outdated: [{ name: 'axios', declared: '^1.1.0', latest: '1.20.0', drift: 'minor' }],
        vulnerable: [{ name: 'axios', advisories: ['GHSA-1', 'GHSA-2'] }]
    }));
    check('a dependency check reports real numbers', /Checked 20 packages/.test(deps.summary), deps.summary);
    check('the specific version drift is shown',
        deps.evidence.some(e => e.includes('axios ^1.1.0 → 1.20.0')), deps.evidence);

    // Nothing resolved must not read as a clean bill of health.
    const nothing = narrateResult('check_dependencies', {}, ok({
        checked: 5, unresolved: ['a', 'b', 'c', 'd', 'e'], outdated: [], vulnerable: []
    }));
    check('resolving nothing is not reported as healthy',
        /could not resolve/i.test(nothing.summary), nothing.summary);
}

// ── Failures say what actually went wrong ───────────────────────────────────
{
    const failed = narrateResult('push_file', { path: 'a.js' },
        fail('FORBIDDEN', 'Resource not accessible by integration', { hint: 'Grant write access.' }));

    check('a failure reports the real reason',
        failed.summary === 'Resource not accessible by integration', failed.summary);
    check('a failure is not marked ok', failed.ok === false);
    check('a hint is passed through as evidence', failed.evidence.includes('Grant write access.'));
}

// ── A skipped repeat is labelled, not passed off as fresh work ──────────────
{
    const repeated = narrateResult('push_file', { repoName: 'a/b', path: 'x.js', commitMessage: 'm' },
        ok({ path: 'x.js', alreadyApplied: true }));
    check('a skipped repeat says it was not repeated',
        /already done earlier in this run/.test(repeated.summary), repeated.summary);
}

// ── The loop emits narration alongside the work ─────────────────────────────
{
    const registry = new ToolRegistry().register({
        name: 'get_file',
        description: 'Reads a file.',
        parameters: { type: 'object', properties: {} },
        handler: async () => ok({ content: 'line one\nline two\n' })
    });

    let turn = 0;
    const router = {
        async complete() {
            turn++;
            if (turn === 1) {
                return {
                    text: 'Let me open the entry point first so I can see what it does.',
                    toolCalls: [{ id: 't1', name: 'get_file', args: { repoName: 'acme/api', path: 'src/index.js' } }],
                    usage: {}
                };
            }
            return { text: 'That file is small — nothing needed changing.', toolCalls: [], usage: {} };
        }
    };

    const events = [];
    const result = await runAgent({
        messages: [system('s'), user('look at my entry point')],
        registry,
        router,
        context: {},
        onEvent: async (e) => events.push(e)
    });

    const narration = events.find(e => e.type === 'narration');
    check('the model explanation is emitted, not swallowed', Boolean(narration), events.map(e => e.type));
    check('it is the model own words',
        narration?.text === 'Let me open the entry point first so I can see what it does.', narration?.text);

    const call = events.find(e => e.type === 'tool_call');
    check('a tool call carries plain-language narration',
        call?.narration === 'Opening src/index.js in acme/api', call?.narration);

    const done = events.find(e => e.type === 'tool_result');
    check('a tool result carries a readable summary', /Read src\/index\.js/.test(done?.narration), done?.narration);
    check('a tool result carries evidence', done?.evidence?.some(e => e.includes('line one')), done?.evidence);

    check('the final answer is still the model own', result.text === 'That file is small — nothing needed changing.');

    // Ordering matters: the explanation must precede the action it explains.
    const order = events.map(e => e.type);
    check('narration comes before the tool call it explains',
        order.indexOf('narration') < order.indexOf('tool_call'), order);
}

report('narration');
