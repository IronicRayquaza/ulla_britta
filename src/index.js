const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const { analyzeCommits } = require('./services/ai.service');
const { generatePDF } = require('./services/pdf.service');
const { sendEmail } = require('./services/email.service');
const { performDiagnostics, handleConflict } = require('./services/healing.service');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const REPO = process.env.TARGET_REPO; 

// Lock to prevent concurrent "Surgeries" on the same run
const activeRuns = new Set();

app.use(express.json());

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;
  const id = req.headers['x-github-delivery'];

  console.log(`>>> [${new Date().toISOString()}] Received: ${event} (ID: ${id})`);
  res.status(202).send('Accepted'); // 202 Accepted is more appropriate for async tasks

  try {
    switch(event) {
      case 'push':
        await handlePush(payload, id);
        break;
      case 'pull_request':
        await handlePullRequest(payload, id);
        break;
      case 'workflow_run':
      case 'check_run':
        await handleBuildFailure(event, payload, id);
        break;
      case 'ping':
        console.log('✨ GitHub Connection Verified (Ping)');
        break;
      default:
        console.log(`ℹ️ Ignored event: ${event}`);
    }
  } catch (error) {
    console.error(`❌ Error in event loop (${event}):`, error.message);
  }
});

// --- Event Handlers ---

async function handlePush(payload, id) {
  if (payload.commits && payload.commits.some(c => c.message.includes('[AI-AUTO-FIX]'))) return;

  const repository = payload.repository.full_name;
  console.log(`📝 [NARRATOR] Analyzing new push to ${repository}...`);
  
  try {
    const analysis = await analyzeCommits(payload.commits, repository);
    const pdfPath = await generatePDF(analysis);
    await sendEmail(pdfPath, repository);
    console.log(`✅ [NARRATOR] Report sent successfully.`);
  } catch (error) {
    console.error(`❌ [NARRATOR] Failed:`, error.message);
  }
}

async function handlePullRequest(payload, id) {
  const repository = payload.repository.full_name;
  let pr = payload.pull_request;
  
  if (payload.action !== 'opened' && payload.action !== 'synchronize') return;

  console.log(`🔍 [MEDIATOR] Checking PR #${pr.number} for conflicts...`);
  
  // Wait for GitHub to calculate mergeability (can take a few seconds)
  for (let i = 0; i < 5; i++) {
    if (pr.mergeable !== null && pr.mergeable !== undefined) break;
    console.log(`   ...Waiting for mergeable status (attempt ${i+1})`);
    await new Promise(r => setTimeout(r, 4000));
    const { data } = await axios.get(pr.url, {
        headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
    });
    pr = data;
  }

  if (pr.mergeable === false) {
      console.log(`💥 [MEDIATOR] Conflict confirmed in PR #${pr.number}. Starting resolution...`);
      await handleConflict(pr.number, repository, pr.head.ref, pr.base.ref);
  } else {
      console.log(`✅ [MEDIATOR] No conflicts found for PR #${pr.number}.`);
  }
}

async function handleBuildFailure(event, payload, id) {
  const repository = payload.repository.full_name;
  const isWorkflow = event === 'workflow_run';
  const data = isWorkflow ? payload.workflow_run : payload.check_run;
  const runId = isWorkflow ? data.id : data.id; // Same for both
  const branch = isWorkflow ? data.head_branch : (data.check_suite ? data.check_suite.head_branch : 'master');

  if (payload.action !== 'completed' || data.conclusion !== 'failure') return;
  
  // Guard against loops
  if (isWorkflow && data.head_commit && data.head_commit.message.includes('[AI-AUTO-FIX]')) return;

  if (activeRuns.has(runId)) {
    console.log(`⏭️ [SURGEON] Run ${runId} already being handled. Skipping.`);
    return;
  }

  activeRuns.add(runId);
  console.log(`🚑 [SURGEON] Build failed on branch [${branch}]. Starting surgery...`);
  
  try {
    const fix = await performDiagnostics(runId, repository, isWorkflow ? null : data, branch);
    if (fix) {
       console.log(`✨ [SURGEON] Successfully applied fix: ${fix.explanation}`);
    }
  } catch (error) {
    console.error('❌ [SURGEON] Surgery failed:', error.message);
  } finally {
    activeRuns.delete(runId);
  }
}

// --- Auto-Config Logic ---

async function autoConfigureWebhook() {
  if (!REPO) {
    console.warn('⚠️ TARGET_REPO not set in .env. Skipping auto-webhook configuration.');
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
        config: { url: publicUrl, content_type: 'json' },
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
    console.error('❌ [CONFIG] Failed to auto-configure webhook:', error.message);
  }
}

app.listen(port, async () => {
  console.log(`🚀 CodeNarrator listening on port ${port}`);
  await autoConfigureWebhook();
});
