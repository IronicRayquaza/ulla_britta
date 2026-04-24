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

// NEW: Deployment Approval Endpoint (With Confirmation Page)
app.get('/approve-deployment', async (req, res) => {
    const { repo, owner, installation_id, provider, confirm } = req.query;
    const repoFullName = `${owner}/${repo}`;

    if (confirm !== 'true') {
        // Show confirmation page first to prevent email pre-fetchers
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0d1117; color: #c9d1d9; height: 100vh;">
                <h1 style="color: #58a6ff;">🚀 Ulla Britta Deployment</h1>
                <p>Confirm hosting setup for <b>${repoFullName}</b> via ${provider}?</p>
                <br/>
                <a href="/approve-deployment?repo=${repo}&owner=${owner}&installation_id=${installation_id}&provider=${provider}&confirm=true" 
                   style="background: #238636; color: white; padding: 15px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 1.2rem;">
                   YES, INITIATE SETUP
                </a>
                <p style="margin-top: 40px; color: #8b949e; font-size: 0.9rem;">This will link your repo to ${provider} and update your GitHub homepage.</p>
            </div>
        `);
    }

    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0d1117; color: #c9d1d9; height: 100vh;">
            <h1 style="color: #238636;">⚙️ Setup In Progress...</h1>
            <p>Ulla Britta is now orchestrating the infrastructure for <b>${repoFullName}</b>.</p>
            <p>Check your email in a minute for the live link.</p>
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
