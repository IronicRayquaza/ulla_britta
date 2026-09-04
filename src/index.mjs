import express from 'express';
import cors from 'cors';
import { enqueueTask } from './queue.mjs';
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
app.use(express.json());
app.use(express.static('public')); // Serve the dashboard

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

        await logger.info(`✅ GitHub App linked: ${install.account.login} (installation ${installationId}) → user ${userId}`);
        res.json({ success: true, account: install.account.login });
    } catch (err) {
        console.error('❌ GitHub link-installation failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// Start the Vercel Sentinel (Polls every 2 minutes)
setInterval(() => {
    vercelSentinel.checkForFailures().catch(err => console.error('Sentinel Error:', err));
}, 2 * 60 * 1000);

// Run once immediately on startup
vercelSentinel.checkForFailures().catch(err => console.error('Sentinel Startup Error:', err));

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
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (signature !== expectedSignature) {
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

    if (!githubService.verifySignature(JSON.stringify(payload), signature)) {
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

// ==========================================
// BACKGROUND CRON JOBS (Sentinel Loop)
// ==========================================
setInterval(async () => {
    try {
        console.log("⏰ Running Daily Sentinel Maintenance...");
        const integrations = await databaseService.getAllIntegrations();
        for (const integration of integrations) {
            const { github_username } = integration;
            const client = await githubService.getClientForOrg(github_username);
            const { data: repos } = await client.rest.repos.listForAuthenticatedUser();
            
            for (const repo of repos) {
                const repoFullName = repo.full_name;
                // Enqueue the daily maintenance tasks
                await enqueueTask('update_dependencies', { repository: { full_name: repoFullName } });
                await enqueueTask('check_repo_health', { repository: { full_name: repoFullName } });
                await enqueueTask('clean_stale_issues', { repository: { full_name: repoFullName } });
            }
        }
    } catch (e) {
        console.error("❌ Daily Maintenance Failed:", e.message);
    }
}, 24 * 60 * 60 * 1000); // Run every 24 hours

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ingestion Tier online. Monitoring at /health`));
