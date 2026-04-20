const express = require('express');
const dotenv = require('dotenv');
const githubService = require('./services/github.service');
const queueService = require('./queue');
const axios = require('axios');

dotenv.config();

// 1. SECRETS VALIDATION (Fail Fast)
const REQUIRED_VARS = ['GEMINI_API_KEY', 'GITHUB_TOKEN', 'REDIS_URL'];
REQUIRED_VARS.forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ CRITICAL: Missing environment variable: ${v}`);
    process.exit(1);
  }
});

const app = express();
const port = process.env.PORT || 3000;
const REPO = process.env.TARGET_REPO;

app.use(express.json());

// 2. HEALTH CHECK (For Monitoring)
app.get('/health', async (req, res) => {
  try {
    const redisStatus = await queueService.client.ping();
    res.status(200).json({ status: 'healthy', redis: redisStatus === 'PONG' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  // 3. SPAM GUARD (Infinite Loop Prevention)
  const isBot = payload.sender?.type === 'Bot' || payload.sender?.login?.includes('[bot]');
  const isAiCommit = payload.commits?.some(c => c.message.includes('[AI-AUTO-FIX]'));
  
  if (isBot || isAiCommit) {
    console.log(`⏭️ Ignored event from bot or AI-auto-fix.`);
    return res.status(200).send('Ignored');
  }

  try {
      await queueService.enqueue({
          type: event,
          payload: payload,
          id: req.headers['x-github-delivery'],
          retryCount: 0
      });
      res.status(202).send('Queued');
  } catch (err) {
      console.error('Failed to queue event:', err.message);
      res.status(500).send('Internal Error');
  }
});

app.listen(port, () => {
    console.log(`🚀 Ingestion Tier online. Monitoring at /health`);
});
