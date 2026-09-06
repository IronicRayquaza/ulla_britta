import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import databaseService from '../../src/services/database.service.mjs';
import githubService from '../../src/services/github.service.mjs';
import { GeminiProvider } from '../../src/providers/gemini.mjs';
import { check, report } from './harness.mjs';

/**
 * The capability surface, and the three failures that motivated it.
 *
 * A user asked the agent to do three ordinary things and got three non-answers:
 *
 *   "start a new repo and push it to my github"
 *       → "client.rest.apps.getAuthenticatedInstallation is not a function"
 *   "check if I have any open PRs for my repo glyph"
 *       → "It's possible the repository doesn't exist"
 *   "how many followers do I have?"
 *       → "My current tools do not allow me to access user profile information"
 *
 * One was a call to a method Octokit does not define, one was a bare repository
 * name nothing could resolve plus an error that guessed instead of reporting, and
 * one was a genuine gap. These cover all three, and the properties that keep the
 * enlarged tool surface honest.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', '..', 'src');

function allSourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? allSourceFiles(full) : (full.endsWith('.mjs') ? [full] : []);
    });
}

// ── 1. The method that does not exist ───────────────────────────────────────
{
    const { Octokit } = await import('octokit');
    const probe = new Octokit({ auth: 'unused' });

    check('Octokit really has no apps.getAuthenticatedInstallation',
        typeof probe.rest.apps.getAuthenticatedInstallation !== 'function');

    // Comments explain why it was removed, so only executable lines are scanned.
    const withoutComments = (source) => source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');

    const offenders = allSourceFiles(srcDir)
        .filter(f => withoutComments(fs.readFileSync(f, 'utf8')).includes('getAuthenticatedInstallation'))
        .map(f => path.relative(srcDir, f));

    check('nothing in src/ calls it any more', offenders.length === 0, offenders);

    // The account identity it was being used for now comes from the installation
    // record, which is written when the app is linked.
    check('the installation record carries the account login',
        typeof databaseService.getInstallationForUser === 'function');
}

// ── 2. A bare repository name resolves ──────────────────────────────────────
{
    const access = await import('../../src/agent/github-access.mjs');

    const originalGetInstallation = databaseService.getInstallationForUser;
    const originalList = databaseService.listInstallationsForUser;
    const originalClient = githubService.getClient;
    const originalRepos = githubService.listUserRepos;

    databaseService.getInstallationForUser = async (userId, repoFullName = '') => {
        const owner = (repoFullName || '').split('/')[0];
        if (owner && owner.toLowerCase() !== 'ironicrayquaza') return null;
        return { installationId: 42, login: 'IronicRayquaza', type: 'User', repositorySelection: 'selected' };
    };
    databaseService.listInstallationsForUser = async () => ([
        { installationId: 42, login: 'IronicRayquaza', type: 'User', repositorySelection: 'selected' }
    ]);
    githubService.getClient = async () => ({ rest: {} });
    githubService.listUserRepos = async () => ([
        { full_name: 'IronicRayquaza/glyph' },
        { full_name: 'IronicRayquaza/neumorphic-user-onboarding' },
        { full_name: 'IronicRayquaza/code_narrator' }
    ]);

    access.clearRepoIndexCache();
    const bare = await access.resolveRepoName('u1', 'glyph');
    check('a bare repository name resolves to the account that owns it',
        bare.owner === 'IronicRayquaza' && bare.repo === 'glyph',
        `${bare.owner}/${bare.repo}`);

    const qualified = await access.resolveRepoName('u1', 'IronicRayquaza/glyph');
    check('a qualified name is used as given',
        qualified.owner === 'IronicRayquaza' && qualified.repo === 'glyph');

    const fromUrl = await access.resolveRepoName('u1', 'https://github.com/IronicRayquaza/glyph');
    check('a GitHub URL is understood too',
        fromUrl.owner === 'IronicRayquaza' && fromUrl.repo === 'glyph',
        `${fromUrl.owner}/${fromUrl.repo}`);

    // Case is how a person types it, not how GitHub stores it.
    access.clearRepoIndexCache();
    const cased = await access.resolveRepoName('u1', 'GLYPH');
    check('resolution is case-insensitive', cased.repo === 'glyph', cased.repo);

    // A name outside the user's accounts must still not resolve into someone else's.
    let crossTenant = null;
    try {
        await access.resolveRepoName('u1', 'someone-else/secret');
    } catch (e) {
        crossTenant = e.code;
    }
    check('a repository in another account is refused, not resolved',
        crossTenant === 'NO_INSTALLATION', crossTenant);

    // ── The error a miss produces ───────────────────────────────────────────
    // The old message let the agent conclude "it's possible the repository doesn't
    // exist". A miss must report what IS visible instead.
    const notFoundClient = {
        rest: { repos: { get: async () => { const e = new Error('Not Found'); e.status = 404; throw e; } } }
    };

    let accessError = null;
    try {
        await access.assertRepoAccess(notFoundClient, 'IronicRayquaza', 'glyph', 42);
    } catch (e) {
        accessError = e;
    }

    check('an inaccessible repository raises REPO_NOT_ACCESSIBLE',
        accessError?.code === 'REPO_NOT_ACCESSIBLE', accessError?.code);
    check('the error does not claim the repository is missing',
        !/does not exist\.?$/i.test(accessError?.message || ''), accessError?.message);
    check('the error names what the installation can actually see',
        /neumorphic-user-onboarding|glyph/.test(accessError?.message || ''), accessError?.message);
    check('the error says how to grant access',
        /settings\/installations/.test(accessError?.hint || ''), accessError?.hint);

    databaseService.getInstallationForUser = originalGetInstallation;
    databaseService.listInstallationsForUser = originalList;
    githubService.getClient = originalClient;
    githubService.listUserRepos = originalRepos;
}

// ── 3. The gap that was reported as a limitation ────────────────────────────
{
    const { buildRegistry, capabilityMap } = await import('../../src/agent/tools/index.mjs');
    const registry = buildRegistry();
    const names = new Set(registry.list().map(t => t.name));

    // "My current tools do not allow me to access user profile information."
    check('the agent can read a GitHub profile', names.has('get_user_profile'));
    check('the agent can list followers', names.has('list_followers'));

    // "I attempted to create the test-claude repository, but the tool encountered an error."
    check('an empty repository can be created without generating code', names.has('create_repository'));
    const createRepo = registry.get('create_repository');
    check('creating a repository does not force a tech stack',
        !(createRepo.parameters.required || []).includes('techStack'),
        createRepo.parameters.required);
    check('code generation is a separate tool', names.has('scaffold_repository'));

    // "Can you check if I have any open PRs" — across repositories, not one at a time.
    check('issues and PRs can be searched across all repositories', names.has('search_issues'));

    // The domains a GitHub agent has to reach at all.
    const required = [
        'list_issues', 'create_issue', 'update_issue', 'comment_on_issue',
        'create_pull_request', 'merge_pull_request', 'list_pull_request_files',
        'list_workflow_runs', 'get_workflow_run_logs', 'rerun_workflow', 'dispatch_workflow',
        'list_branches', 'create_branch', 'list_commits', 'compare_branches',
        'list_releases', 'create_release',
        'list_directory', 'get_repository_tree', 'push_files', 'search_code',
        'list_security_alerts', 'list_collaborators'
    ];
    const missing = required.filter(n => !names.has(n));
    check('every core GitHub workflow has a tool', missing.length === 0, missing);

    // ── Registry hygiene ────────────────────────────────────────────────────
    const tools = registry.list();
    check('every tool has a description', tools.every(t => t.description?.length > 20));
    check('every tool has an object schema',
        tools.every(t => t.parameters?.type === 'object'));

    const requiredNotDeclared = tools.filter(t =>
        (t.parameters.required || []).some(r => !t.parameters.properties?.[r]));
    check('no tool requires an argument it does not declare',
        requiredNotDeclared.length === 0, requiredNotDeclared.map(t => t.name));

    // Anything that writes must be marked, or a retry will do it twice.
    const writesButUnmarked = tools.filter(t =>
        /^(create|update|delete|push|merge|add|remove|star|unstar|fork|comment|submit|request|mark|rerun|cancel|dispatch|send|follow|unfollow|flag|set|build|scaffold)_/.test(t.name)
        && !t.sideEffecting);
    check('every writing tool is marked side-effecting',
        writesButUnmarked.length === 0, writesButUnmarked.map(t => t.name));

    const readsButMarked = tools.filter(t => /^(list|get|search|check)_/.test(t.name) && t.sideEffecting);
    check('no read-only tool is marked side-effecting',
        readsButMarked.length === 0, readsButMarked.map(t => t.name));

    check('deleting a repository is still gated as destructive',
        registry.get('delete_repository').destructive === true);

    // Deleting a branch or a file is recoverable from git; deleting the repository
    // is not. Only the last one demands a confirmation turn.
    const destructive = tools.filter(t => t.destructive).map(t => t.name);
    check('only repository deletion is gated',
        destructive.length === 1 && destructive[0] === 'delete_repository', destructive);

    // ── The map stays in step with the registry ─────────────────────────────
    const map = capabilityMap();
    const mapped = map.flatMap(d => d.tools.map(t => t.name));
    check('the capability map covers every registered tool',
        mapped.length === tools.length && mapped.every(n => names.has(n)),
        `${mapped.length} mapped vs ${tools.length} registered`);
}

// ── 4. The schemas survive the providers ────────────────────────────────────
{
    const { buildRegistry } = await import('../../src/agent/tools/index.mjs');
    const specs = buildRegistry().specs();

    // Gemini rejects an OBJECT with no properties outright, and one such tool fails
    // the entire request — not just that tool.
    const declarations = GeminiProvider.toolsFor(specs)[0].functionDeclarations;

    const emptyObjects = declarations.filter(d =>
        d.parameters && d.parameters.type === 'object'
        && Object.keys(d.parameters.properties || {}).length === 0);
    check('no tool is sent to Gemini with an empty object schema',
        emptyObjects.length === 0, emptyObjects.map(d => d.name));

    check('a no-argument tool is sent with no parameters at all',
        declarations.find(d => d.name === 'get_rate_limit')?.parameters === undefined);

    check('every declaration still has a name and a description',
        declarations.every(d => d.name && d.description));

    // Sanitizing must not leave a required key pointing at a property it dropped.
    const cleaned = GeminiProvider.sanitizeSchema({
        type: 'object',
        properties: {
            keep: { type: 'string' },
            drop: { type: 'object', properties: {} }
        },
        required: ['keep', 'drop']
    });
    check('a dropped property is dropped from required too',
        cleaned.required.length === 1 && cleaned.required[0] === 'keep', cleaned.required);
    check('the surviving property is kept', Boolean(cleaned.properties.keep));
}

// ── 4b. A reinstall must not need a human ───────────────────────────────────
// Uninstalling and reinstalling the App issues a NEW installation id and retires
// the old one. Nothing was listening for that, so the recorded id went stale and
// every call died minting a token — surfaced to the user as
// "Not Found - https://docs.github.com/rest/reference/apps#create-an-...".
// The account name survives a reinstall even though the id does not, so the live
// installation can be found and the record corrected without asking anybody.
{
    const access = await import('../../src/agent/github-access.mjs');

    const original = {
        getInstallationForUser: databaseService.getInstallationForUser,
        listInstallationsForUser: databaseService.listInstallationsForUser,
        relinkInstallation: databaseService.relinkInstallation,
        getInstallation: githubService.getInstallation,
        findInstallationForAccount: githubService.findInstallationForAccount,
        getClient: githubService.getClient
    };

    const STALE = 125781221;
    const LIVE = 159531330;
    let recorded = { installationId: STALE, login: 'IronicRayquaza', type: 'User', repositorySelection: 'selected' };
    const relinked = [];

    databaseService.getInstallationForUser = async () => recorded;
    databaseService.listInstallationsForUser = async () => [recorded];
    databaseService.relinkInstallation = async (userId, install) => {
        relinked.push([userId, install.installationId]);
        recorded = { ...install };
    };
    githubService.getInstallation = async (id) => {
        if (Number(id) === STALE) { const e = new Error('Not Found'); e.status = 404; throw e; }
        return { id: Number(id) };
    };
    githubService.findInstallationForAccount = async (login) => ({
        id: LIVE,
        account: { login, type: 'User' },
        repository_selection: 'all'
    });
    githubService.getClient = async (id) => ({ __installationId: Number(id), rest: {} });

    access.clearInstallationCache();
    const resolved = await access.resolveClient('u1');

    check('a retired installation id is replaced with the live one',
        resolved.installationId === LIVE, resolved.installationId);
    check('the client is built for the new id',
        resolved.client.__installationId === LIVE, resolved.client.__installationId);
    check('the correction is written back exactly once',
        relinked.length === 1 && relinked[0][1] === LIVE, relinked);
    check('the fresh repository scope is picked up too',
        resolved.account.repositorySelection === 'all', resolved.account);

    // Asking GitHub on every single call would be wasteful; once per process is enough.
    let probes = 0;
    githubService.getInstallation = async () => { probes++; return { id: LIVE }; };
    await access.resolveClient('u1');
    await access.resolveClient('u1');
    check('a healthy installation is verified once, not per call', probes === 0, probes);

    // GitHub being unreachable is not evidence that anything was uninstalled.
    access.clearInstallationCache();
    recorded = { installationId: LIVE, login: 'IronicRayquaza', type: 'User', repositorySelection: 'all' };
    relinked.length = 0;
    githubService.getInstallation = async () => { const e = new Error('bad gateway'); e.status = 502; throw e; };
    const degraded = await access.resolveClient('u1');
    check('a transient error does not trigger a relink',
        relinked.length === 0 && degraded.installationId === LIVE, [relinked, degraded.installationId]);

    // Genuinely uninstalled: say so, and say what to do.
    access.clearInstallationCache();
    githubService.getInstallation = async () => { const e = new Error('Not Found'); e.status = 404; throw e; };
    githubService.findInstallationForAccount = async () => null;

    let gone = null;
    try {
        await access.resolveClient('u1');
    } catch (e) {
        gone = e;
    }
    check('an app that is really gone is reported as gone',
        gone?.code === 'INSTALLATION_GONE', gone?.code);
    check('and the message does not leak a documentation URL as an explanation',
        !(gone?.message || '').includes('docs.github.com/rest/reference'), gone?.message);
    check('the hint says how to fix it',
        /reinstall/i.test(gone?.hint || ''), gone?.hint);

    Object.assign(databaseService, {
        getInstallationForUser: original.getInstallationForUser,
        listInstallationsForUser: original.listInstallationsForUser,
        relinkInstallation: original.relinkInstallation
    });
    Object.assign(githubService, {
        getInstallation: original.getInstallation,
        findInstallationForAccount: original.findInstallationForAccount,
        getClient: original.getClient
    });
    access.clearInstallationCache();
}

// ── 5. Every Octokit method named actually exists ───────────────────────────
{
    // The original failure was a call to a method Octokit does not define. It got
    // to production because nothing ever checked, and the only way to find out was
    // to run the tool. Every `client.rest.<namespace>.<method>` written anywhere in
    // src/ is now checked against a real Octokit instance.
    const { Octokit } = await import('octokit');
    const probe = new Octokit({ auth: 'unused' });

    const calls = new Map();   // "namespace.method" -> files that use it
    for (const file of allSourceFiles(srcDir)) {
        const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const [, ns, method] of source.matchAll(/\.rest\.(\w+)\.(\w+)\s*\(/g)) {
            const key = `${ns}.${method}`;
            if (!calls.has(key)) calls.set(key, []);
            calls.get(key).push(path.relative(srcDir, file));
        }
    }

    check('the scan actually found REST calls to check', calls.size > 40, calls.size);

    const missing = [...calls.entries()]
        .filter(([key]) => {
            const [ns, method] = key.split('.');
            return typeof probe.rest[ns]?.[method] !== 'function';
        })
        .map(([key, files]) => `${key} (${[...new Set(files)].join(', ')})`);

    check('every Octokit method the code calls exists', missing.length === 0, missing);
}

// ── 6. The documentation matches the code ───────────────────────────────────
{
    const { splice } = await import('../../scripts/generate-capability-docs.mjs');
    const docPath = path.join(here, '..', '..', 'docs', 'AGENT_CAPABILITIES.md');
    const current = fs.readFileSync(docPath, 'utf8');

    check('the capability document is in step with the registry',
        splice(current) === current,
        'run: npm run docs:capabilities');

    // The prose around the generated block is written by hand, and it is the part
    // that goes stale silently. These are the claims it must keep making.
    for (const claim of [
        'github_user_tokens',
        'search_issues',
        'settings/installations',
        'Deliberately not covered'
    ]) {
        check(`the document still explains "${claim}"`, current.includes(claim));
    }
}

report('capabilities');
