import express from 'express';
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
import chatService from './services/chat.service.mjs';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve the dashboard

// Chat API Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { message, userId } = req.body;
        const fallbackId = 'a66ceed4-63a5-405a-85b5-9f8f59946690';
        
        const response = await chatService.processMessage(userId || fallbackId, message);
        res.json({ response });
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: 'Ulla is having trouble thinking right now.' });
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
        const userId = state || 'a66ceed4-63a5-405a-85b5-9f8f59946690';

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

    res.status(202).send({ taskId });
});

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
