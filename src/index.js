const express = require('express');
const dotenv = require('dotenv');
const githubService = require('./services/github.service');
const queueService = require('./queue');
const axios = require('axios');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const REPO = process.env.TARGET_REPO;

app.use(express.json());

// Main Webhook Ingestion Endpoint
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const signature = req.headers['x-hub-signature-256'];
  const payload = req.body;

  // 1. Security Check (Signature Verification)
  // For production, uncomment this and add GITHUB_WEBHOOK_SECRET to .env
  /*
  if (!githubService.verifySignature(JSON.stringify(payload), signature)) {
    return res.status(401).send('Invalid signature');
  }
  */

  // 2. Filter out bot's own commits to avoid infinite loops
  if (payload.commits && payload.commits.some(c => c.message.includes('[AI-AUTO-FIX]'))) {
    return res.status(200).send('Ignored (self-trigger)');
  }

  // 3. Queue the event for the Worker
  try {
      await queueService.enqueue({
          type: event,
          payload: payload,
          id: req.headers['x-github-delivery']
      });
      res.status(202).send('Queued');
  } catch (err) {
      console.error('Failed to queue event:', err.message);
      res.status(500).send('Internal Error');
  }
});

/**
 * Auto-Config Logic for easy setup
 */
async function autoConfigureWebhook() {
  if (!REPO) {
    console.warn('⚠️ TARGET_REPO not set. Auto-config skipped.');
    return;
  }

  console.log(`🛠️  [CONFIG] Auto-configuring webhook for ${REPO}...`);
  try {
    const ngrokRes = await axios.get('http://127.0.0.1:4040/api/tunnels');
    const publicUrl = ngrokRes.data.tunnels[0].public_url + '/webhook';
    console.log(`🔗 [CONFIG] Your Public URL: ${publicUrl}`);

    const headers = { Authorization: `token ${process.env.GITHUB_TOKEN}` };
    const { data: hooks } = await axios.get(`https://api.github.com/repos/${REPO}/hooks`, { headers });
    
    // Find existing webhook or create new
    const existingHook = hooks.find(h => h.config.url.includes('ngrok'));
    
    const hookConfig = {
        config: { url: publicUrl, content_type: 'json', secret: process.env.GITHUB_WEBHOOK_SECRET || 'development_secret' },
        events: ['push', 'pull_request', 'workflow_run', 'check_run'],
        active: true
    };

    if (existingHook) {
      await axios.patch(`https://api.github.com/repos/${REPO}/hooks/${existingHook.id}`, hookConfig, { headers });
      console.log('✅ [CONFIG] Webhook updated.');
    } else {
      await axios.post(`https://api.github.com/repos/${REPO}/hooks`, { name: 'web', ...hookConfig }, { headers });
      console.log('✅ [CONFIG] New Webhook created.');
    }
  } catch (error) {
    console.warn('⚠️ Auto-config failed. ' + error.message);
  }
}

app.listen(port, async () => {
  console.log(`🚀 CodeNarrator Ingestion Tier running on port ${port}`);
  await autoConfigureWebhook();
});
