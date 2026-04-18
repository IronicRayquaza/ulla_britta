const express = require('express');
const dotenv = require('dotenv');
const { Webhooks } = require('@octokit/webhooks');
const { analyzeCommits } = require('./services/ai.service');
const { generatePDF } = require('./services/pdf.service');
const { sendEmail } = require('./services/email.service');
const { performDiagnostics, handleConflict } = require('./services/healing.service');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET || 'development_secret',
});

// Manual body parser to ensure we have the raw body for signature
app.use(express.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
  console.log('--- Incoming Webhook Request ---');
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const id = req.headers['x-github-delivery'];
  const rawBody = req.body.toString();

  console.log(`Manual Webhook Entry: Event=${event}, ID=${id}`);

  try {
    await webhooks.verifyAndReceive({
      id,
      name: event,
      payload: rawBody,
      signature,
    });
    res.status(200).send('ok');
  } catch (error) {
    console.error('Webhook Verification Failed:', error.message);
    res.status(401).send('verification failed');
  }
});

// 1. Push Event Handler (Reports)
webhooks.on('push', async ({ id, name, payload }) => {
  // Ignore commits made by the AI to prevent feedback loops
  if (payload.commits && payload.commits.some(c => c.message.includes('[AI-AUTO-FIX]'))) {
    console.log(`Skipping report generation for AI-triggered commit.`);
    return;
  }

  console.log(`Received push event: ${id}`);
  const repository = payload.repository.full_name;
  const commits = payload.commits;
  
  (async () => {
    try {
      const analysis = await analyzeCommits(commits, repository);
      const pdfPath = await generatePDF(analysis);
      await sendEmail(pdfPath, repository);
      console.log(`Successfully processed event ${id}. Report path: ${pdfPath}`);
    } catch (error) {
      console.error(`Failed background process ${id}:`, error.message);
    }
  })();
});

// 2. Pull Request Event Handler (Reports + Conflicts)
webhooks.on('pull_request', async ({ id, name, payload }) => {
  const repository = payload.repository.full_name;
  const pr = payload.pull_request;

  if (payload.action === 'opened' || payload.action === 'synchronize') {
    console.log(`Analyzing PR #${pr.number} for conflicts...`);
    
    // Sometimes mergeable is null while GitHub calculates it
    // We wait and check again if needed
    (async () => {
        try {
            let mergeable = pr.mergeable;
            if (mergeable === null) {
                console.log(`Mergeable status null, waiting...`);
                await new Promise(r => setTimeout(r, 5000));
                // We'd ideally re-fetch the PR state here, but for now we proceed
                // and handle errors in handleConflict
            }

            if (mergeable === false) {
                console.log(`⚠️ Conflict detected in PR #${pr.number} (${repository}).`);
                await handleConflict(pr.number, repository, pr.head.ref, pr.base.ref);
            }
        } catch (err) {
            console.error('Error in PR conflict processing:', err.message);
        }
    })();
  }

  if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
  
  console.log(`Received Pull Request event: ${id} (${payload.action})`);
  
  const mockCommits = [{
    id: pr.head.sha,
    message: `PR #${pr.number}: ${pr.title}\n\n${pr.body || ''}`,
    author: { name: payload.sender.login }
  }];

  (async () => {
    try {
      const analysis = await analyzeCommits(mockCommits, repository);
      const pdfPath = await generatePDF(analysis);
      await sendEmail(pdfPath, repository);
      console.log(`Successfully processed PR ${id}. Report path: ${pdfPath}`);
    } catch (error) {
      console.error(`Failed background process PR ${id}:`, error.message);
    }
  })();
});

// 4. Check Run Event Handler (External Deployments like Vercel)
webhooks.on('check_run', async ({ id, name, payload }) => {
  if (payload.action !== 'completed') return;
  
  const { conclusion, check_run } = payload;
  const repository = payload.repository.full_name;

  if (conclusion === 'failure') {
    console.log(`⚠️ External Check Failure detected: ${check_run.name} in ${repository}`);
    
    // For external checks, we don't always have a workflow ID, 
    // but we can try to diagnose based on the check's output/summary.
    (async () => {
      try {
        console.log(`Starting Diagnostics for external failure: ${check_run.name}...`);
        
        // We pass a 'null' runId but the actual check_run object for context
        const fix = await performDiagnostics(null, repository, check_run);
        if (fix) {
           console.log(`✅ [EXTERNAL-FIX] Success: ${fix.explanation}`);
        }
      } catch (error) {
        console.error('External healing failed:', error.message);
      }
    })();
  }
});
webhooks.on('workflow_run', async ({ id, name, payload }) => {
  if (payload.action !== 'completed') return;
  
  // Ignore workflow runs triggered by the AI to prevent feedback loops
  if (payload.workflow_run.head_commit && payload.workflow_run.head_commit.message.includes('[AI-AUTO-FIX]')) {
    console.log(`Skipping self-healing for AI-triggered run: ${payload.workflow_run.id}`);
    return;
  }

  const conclusion = payload.workflow_run.conclusion;
  
  if (conclusion === 'failure') {
    console.log(`⚠️ Build Failure detected in ${payload.repository.full_name}!`);
    const workflowId = payload.workflow_run.id;
    const repoName = payload.repository.full_name;
    
    (async () => {
      try {
        console.log(`Starting Self-Healing Diagnostics for workflow ${workflowId}...`);
        const fix = await performDiagnostics(workflowId, repoName);
        if (fix) {
           console.log(`✅ [SELF-HEALING] Success: ${fix.explanation}`);
        } else {
           console.log('⚠️ [SELF-HEALING] Could not automatically fix this error.');
        }
      } catch (error) {
        console.error('Self-Healing failed:', error.message);
      }
    })();
  }
});

webhooks.on('ping', async ({ payload }) => {
  console.log(`Received ping: ${payload.zen}`);
});

app.listen(port, () => {
  console.log(`CodeNarrator listening at http://localhost:${port}`);
});
