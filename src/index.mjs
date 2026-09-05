import express from 'express';
import cors from 'cors';
import queue, { enqueueTask } from './queue.mjs';
import githubService from './services/github.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import databaseService from './services/database.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import logger from './services/logger.service.mjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import vercelService from './services/vercel.service.mjs';
import vercelIntegrationService from './services/vercel-integration.service.mjs';
import vercelSentinel from './services/vercel-sentinel.service.mjs';
import agentService from './agent/index.mjs';
import requireAuth from './middleware/auth.mjs';
import runsRouter from './routes/runs.mjs';
import * as githubOAuth from './services/github-oauth.service.mjs';
import { capabilityMap } from './agent/tools/index.mjs';

dotenv.config();

const app = express();
// Allowed browser origins. FRONTEND_URL should be set to the deployed dashboard
// origin (comma-separated if there is more than one).
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'https://ulla-britta.onrender.com',
    ...(process.env.FRONTEND_URL || '').split(',').map(o => o.trim()).filter(Boolean)
];

app.use(cors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// Keep the exact bytes of the request for signature verification. Re-serialising
// the parsed body with JSON.stringify does not reliably reproduce what was signed,
// so a valid webhook could be rejected on nothing more than key ordering or
// unicode escaping.
app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.static('public')); // Serve the dashboard

// Durable runs: start, watch, cancel, and read history.
app.use('/api/runs', runsRouter);

// Chat Status Endpoint (For the dashboard status bar)
app.get('/api/chat/status', requireAuth, async (req, res) => {
    try {
        const { userId } = req.auth;
        const activity = await databaseService.getRecentActivity(userId, 5);
        const integrations = await databaseService.getAllVercelIntegrations();

        res.json({
            status: 'online',
            activeIntegrations: integrations.length,
            recentFixes: activity.length,
            lastActivity: activity[0]?.created_at || null
        });
    } catch (err) {
        res.status(500).json({ status: 'error' });
    }
});

// Chat API Endpoint
app.post('/api/chat', requireAuth, async (req, res) => {
    try {
        const { message } = req.body;

        if (typeof message !== 'string' || message.trim() === '') {
            return res.status(400).json({ error: 'A non-empty message is required.' });
        }

        // userId comes from the verified token only — never from the request body.
        const result = await agentService.processMessage(req.auth.userId, message);

        res.json({
            response: result.text,
            ok: result.ok,
            stopReason: result.stopReason,
            // What actually ran, so the client never has to infer it from wording.
            performed: result.performed,
            budget: result.budget
        });
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: `The run failed: ${error.message}` });
    }
});

// ── GitHub App Onboarding ──────────────────────────────────────────────────
// Called by the frontend after GitHub App install redirect returns installation_id
app.post('/github/link-installation', requireAuth, async (req, res) => {
    try {
        const { userId } = req.auth;
        const { installationId } = req.body;

        if (!installationId) {
            return res.status(400).json({ error: 'installationId is required' });
        }

        // Fetch installation details from GitHub to get account_login
        const { Octokit } = await import('octokit');
        const { createAppAuth } = await import('@octokit/auth-app');
        const appOctokit = new Octokit({
            authStrategy: createAppAuth,
            auth: {
                appId: process.env.GITHUB_APP_ID,
                privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }
        });

        const { data: install } = await appOctokit.rest.apps.getInstallation({ installation_id: Number(installationId) });

        // Save to github_installations table
        const { createClient } = await import('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

        await sb.from('github_installations').upsert({
            user_id: userId,
            installation_id: Number(installationId),
            account_login: install.account.login,
            account_type: install.account.type,
            repositories_access: install.repository_selection,
            status: 'active',
            installed_at: new Date().toISOString(),
            last_sync_at: new Date().toISOString()
        }, { onConflict: 'installation_id' });

        // Record the GitHub account on the profile too. Without this, incoming
        // webhooks cannot be attributed to a user: getUserIdByGithubUsername reads
        // profiles.github_username, and nothing was ever writing it.
        await databaseService.linkGithubAccount(userId, install.account.login);

        await logger.info(`✅ GitHub App linked: ${install.account.login} (installation ${installationId}) → user ${userId}`);
        res.json({ success: true, account: install.account.login });
    } catch (err) {
        console.error('❌ GitHub link-installation failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Acting as the user ─────────────────────────────────────────────────────
// An installation token cannot create a repository on a personal account, star,
// follow, read notifications or create a gist — GitHub refuses those to anything
// that is not the person. This is the identifying OAuth flow that gets a user
// token, and it is entirely optional: without it those tools fail with a clear
// explanation rather than a 403.

/** Where the dashboard sends the user to authorize. */
app.get('/github/oauth/url', requireAuth, async (req, res) => {
    if (!githubOAuth.isConfigured()) {
        return res.status(503).json({
            error: 'GitHub user authorization is not configured on this server.',
            hint: 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.'
        });
    }

    // The state is signed with the webhook secret so the callback can trust the
    // user it names. A raw user id here would let anyone bind a token to any account.
    const nonce = crypto.randomBytes(8).toString('hex');
    const payload = `${req.auth.userId}.${Date.now()}.${nonce}`;
    const signature = crypto
        .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET || '')
        .update(payload)
        .digest('hex');

    // Only send an explicit redirect_uri when we know our own public origin.
    // A relative path is not a valid redirect and GitHub rejects the whole request;
    // with none, GitHub uses the callback URL configured on the App.
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

    res.json({
        url: githubOAuth.authorizeUrl({
            state: `${payload}.${signature}`,
            ...(publicUrl && { redirectUri: `${publicUrl}/github/oauth/callback` })
        })
    });
});

/** Where GitHub sends them back. */
app.get('/github/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    const frontend = (process.env.FRONTEND_URL || '').split(',')[0].trim() || '/';

    try {
        if (!code || !state) throw new Error('GitHub did not return a code.');

        const [userId, issuedAt, nonce, signature] = String(state).split('.');
        const expected = crypto
            .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET || '')
            .update(`${userId}.${issuedAt}.${nonce}`)
            .digest('hex');

        const a = Buffer.from(signature || '');
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            throw new Error('That authorization request did not come from here.');
        }
        if (Date.now() - Number(issuedAt) > 15 * 60 * 1000) {
            throw new Error('That authorization link has expired. Start again.');
        }

        const { login } = await githubOAuth.exchangeCode(userId, code);
        await logger.info(`✅ GitHub user authorized: @${login} → user ${userId}`);
        res.redirect(`${frontend}/settings?github_user=${encodeURIComponent(login)}`);
    } catch (err) {
        console.error('❌ GitHub OAuth callback failed:', err.message);
        res.redirect(`${frontend}/settings?github_error=${encodeURIComponent(err.message)}`);
    }
});

/** Whether the agent can currently act as this user. */
app.get('/github/oauth/status', requireAuth, async (req, res) => {
    const token = await githubOAuth.getValidToken(req.auth.userId);
    res.json({
        configured: githubOAuth.isConfigured(),
        connected: Boolean(token),
        login: token?.login || null
    });
});

app.post('/github/oauth/disconnect', requireAuth, async (req, res) => {
    await githubOAuth.disconnect(req.auth.userId);
    res.json({ success: true });
});

/**
 * The agent's capability map, grouped by GitHub domain.
 * The dashboard renders this so "what can it do" is answered from the registry
 * rather than from a list someone maintains by hand.
 */
app.get('/api/capabilities', requireAuth, (_req, res) => {
    const domains = capabilityMap();
    res.json({
        total: domains.reduce((n, d) => n + d.count, 0),
        domains
    });
});


// Start the Vercel Sentinel (Polls every 2 minutes)
// The Vercel Sentinel polls and then performs long-running repair work, so it runs
// in the worker (see src/worker.mjs), not in the request-serving process.

// Vercel OAuth Callback
app.get('/vercel/callback', async (req, res) => {
    console.log(`📡 Vercel Callback Raw Query:`, JSON.stringify(req.query));
    const { code, state, configurationId, teamId } = req.query;

    console.log(`📡 Vercel Integration Callback Received!`);
    console.log(`Params:`, { code: code ? 'PRESENT' : 'MISSING', state, configurationId, teamId });

    if (!code || !configurationId) {
        console.warn(`❌ Auth Failed: Missing parameters. code=${!!code}, configId=${!!configurationId}`);
        return res.status(400).send('Missing integration parameters. Check Vercel settings.');
    }

    try {
        // `state` carries the dashboard user id set when the OAuth flow started.
        // Without it the integration cannot be attributed to anyone — fail loudly
        // rather than silently binding it to a hardcoded account.
        const userId = state;
        if (!userId) {
            console.warn('❌ Vercel callback missing state (user id). Refusing to link.');
            return res.status(400).send('Missing user context. Start the integration from the dashboard.');
        }

        await vercelIntegrationService.exchangeCode(code, userId, configurationId, teamId);

        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0d1117; color: #c9d1d9; height: 100vh;">
                <h1 style="color: #0070f3;">▲ Vercel Integrated!</h1>
                <p>Ulla Britta now has account-wide access to your Vercel projects.</p>
                <p>You can close this window now.</p>
            </div>
        `);
    } catch (e) {
        res.status(500).send(`Integration Failed: ${e.message}`);
    }
});

// Vercel Build Failure Webhook
app.post('/webhooks/vercel', async (req, res) => {
    const signature = req.headers['x-vercel-signature'];
    const VERCEL_SECRET = process.env.VERCEL_WEBHOOK_SECRET;

    if (signature && VERCEL_SECRET) {
        const expectedSignature = crypto
            .createHmac('sha256', VERCEL_SECRET)
            .update(req.rawBody ?? Buffer.from(JSON.stringify(req.body)))
            .digest('hex');

        // Constant-time comparison: a plain !== leaks how much of the signature
        // matched through timing.
        const provided = Buffer.from(String(signature));
        const expected = Buffer.from(expectedSignature);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
            return res.status(401).send('Invalid Vercel signature');
        }
    }

    const event = req.body;
    if (!['deployment.failed', 'deployment.error'].includes(event.type)) {
        return res.status(200).send('Ignored');
    }

    const payload = {
        type: 'vercel_failure',
        deployment_id: event.payload.deployment.id,
        project_name: event.payload.project.name,
        repository: event.payload.project.link?.repo,
        branch: event.payload.deployment.meta?.gitBranch,
        commit: event.payload.deployment.meta?.gitCommitSha
    };

    await enqueueTask('vercel_failure', payload);
    res.status(202).send({ message: 'Vercel failure enqueued' });
});

// Main Webhook Ingestion
app.post('/webhook', async (req, res) => {
    const eventType = req.headers['x-github-event'];
    const signature = req.headers['x-hub-signature-256'];
    const payload = req.body;
    const repository = payload.repository?.full_name;

    if (!githubService.verifySignature(req.rawBody, signature)) {
        return res.status(401).send('Invalid signature');
    }

    // Attempt to tag the log to a user immediately
    if (repository) {
        const owner = repository.split('/')[0];
        const userId = await databaseService.getUserIdByGithubUsername(owner);
        logger.setContext(userId, repository, 'receiver');
        await logger.info(`📥 Webhook Received: ${eventType}. Enqueuing task...`);
    }

    const taskId = await enqueueTask(eventType, payload);

    // Special Handling for Issue-to-Code Phase 2
    if (eventType === 'issues' && payload.action === 'labeled') {
        const label = payload.label.name;
        const ullaLabels = ['ulla-build', 'ulla-fix', 'ulla-enhance', 'ulla-refactor'];

        if (ullaLabels.includes(label)) {
            await enqueueTask('feature_request', {
                issue_number: payload.issue.number,
                issue_title: payload.issue.title,
                issue_body: payload.issue.body,
                repository: payload.repository.full_name,
                owner: payload.repository.owner.login,
                repo: payload.repository.name,
                branch: payload.repository.default_branch || 'main',
                installation: { id: payload.installation.id } // Normalize structure
            });
        }
    }

    // Special Handling for PR Routing Commands
    if (eventType === 'issue_comment' && payload.action === 'created') {
        const commentBody = payload.comment.body.trim();
        if (commentBody === '/pr upstream' || commentBody === '/pr local') {
            await enqueueTask('route_pr', payload);
        }
    }

    // Special Handling for PR Reviews
    if (eventType === 'pull_request' && (payload.action === 'opened' || payload.action === 'synchronize')) {
        await enqueueTask('review_pull_request', payload);
    }

    // Special Handling for Releases
    if (eventType === 'release' && payload.action === 'published') {
        await enqueueTask('generate_changelog', payload);
    }

    res.status(202).send({ taskId });
});

// Scheduled work does NOT live here. A setInterval in the web process does not
// fire on a service that sleeps between requests, and it called a method
// (getAllIntegrations) that no longer exists. Run `npm run maintenance` from a
// platform cron job instead — see src/maintenance.mjs.

// Deployment Approval Endpoint (One-Click Trigger)
app.get('/approve-deployment', async (req, res) => {
    const { repo, owner, installation_id, provider } = req.query;
    const repoFullName = `${owner}/${repo}`;

    const userId = await databaseService.getUserIdByGithubUsername(owner);
    logger.setContext(userId, repoFullName, 'deployment-engine');
    await logger.info(`🛰️ Approval Signal Received for ${repoFullName}. Triggering ${provider}...`);

    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0d1117; color: #c9d1d9; height: 100vh;">
            <h1 style="color: #58a6ff;">🚀 Setup Initiated!</h1>
            <p>Ulla Britta is now setting up hosting for <b>${repoFullName}</b> via ${provider}.</p>
            <p>Check your email in a minute for the live link.</p>
        </div>
    `);

    try {
        let deployUrl;
        if (provider === 'Vercel') {
            deployUrl = await deploymentService.deployToVercel(repoFullName, installation_id);
        } else {
            deployUrl = await deploymentService.deployToGitHubPages(installation_id, repoFullName);
        }

        if (deployUrl) {
            await logger.success(`✅ Deployment Successful! Repository is live.`);
            await sendEmail(`✅ Success! Your project **${repoFullName}** is now live at: ${deployUrl}`, repoFullName);
        } else {
            await logger.error(`❌ Deployment failed. Check server logs for details.`);
        }
    } catch (e) {
        await logger.error(`❌ Approval Error: ${e.message}`);
    }
});

app.get('/health', (req, res) => res.send({ status: 'online', time: new Date() }));

/**
 * Queue depth, including the dead-letter queue that previously accumulated failed
 * tasks that nothing ever read. Counts only — the payloads belong to individual
 * users and are served through /api/runs instead.
 */
app.get('/api/system/queue', requireAuth, async (req, res) => {
    try {
        const [pending, failed] = await Promise.all([
            queue.client.llen('ulla_britta_events'),
            queue.client.llen('ulla_britta_failed')
        ]);
        res.json({ pending, failed, redis: 'connected' });
    } catch (err) {
        res.status(503).json({ error: `Queue unreachable: ${err.message}`, redis: 'disconnected' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ingestion Tier online. Monitoring at /health`));
