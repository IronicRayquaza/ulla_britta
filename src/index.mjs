import express from 'express';
import { enqueueTask } from './queue.mjs';
import githubService from './services/github.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import databaseService from './services/database.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import logger from './services/logger.service.mjs';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

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
