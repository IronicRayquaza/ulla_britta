import express from 'express';
import { enqueueTask } from './queue.mjs';
import githubService from './services/github.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Main Webhook Ingestion
app.post('/webhook', async (req, res) => {
    const eventType = req.headers['x-github-event'];
    const signature = req.headers['x-hub-signature-256'];
    const payload = req.body;

    if (!githubService.verifySignature(JSON.stringify(payload), signature)) {
        return res.status(401).send('Invalid signature');
    }

    const taskId = await enqueueTask(eventType, payload);
    console.log(`📥 Queuing event: ${eventType} (ID: ${taskId})`);
    res.status(202).send({ taskId });
});

// NEW: Deployment Approval Endpoint
app.get('/approve-deployment', async (req, res) => {
    const { repo, owner, installation_id, provider } = req.query;
    const repoFullName = `${owner}/${repo}`;

    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>🚀 Setup Initiated!</h1>
            <p>Ulla Britta is now setting up hosting for <b>${repoFullName}</b> via ${provider}.</p>
            <p>You will receive a confirmation email with your live link in a moment.</p>
        </div>
    `);

    // Run the deployment in the background
    try {
        let deployUrl;
        if (provider === 'Vercel') {
            deployUrl = await deploymentService.deployToVercel(repoFullName, installation_id);
        } else {
            deployUrl = await deploymentService.deployToGitHubPages(installation_id, repoFullName);
        }

        if (deployUrl) {
            await sendEmail(`✅ Success! Your project **${repoFullName}** is now live at: ${deployUrl}`, repoFullName);
        }
    } catch (e) {
        console.error('Approval Deployment Failed:', e.message);
    }
});

app.get('/health', (req, res) => res.send({ status: 'online', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ingestion Tier online. Monitoring at /health`));
