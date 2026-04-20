const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.TARGET_REPO || 'IronicRayquaza/ulla_britta_testing';
const headers = { Authorization: `token ${GITHUB_TOKEN}` };

async function getSha(path, branch = 'master') {
    try {
        const res = await axios.get(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${branch}`, { headers });
        return res.data.sha;
    } catch (e) {
        return null;
    }
}

async function runTests() {
  try {
    console.log('--- STARTING COMPREHENSIVE TEST SUITE ---');

    // TEST 1: PUSH (NARRATOR TEST)
    console.log('1. Pushing a new feature file...');
    const utilsPath = 'src/utils.js';
    const utilsSha = await getSha(utilsPath);
    const featureBody = {
        message: 'feat: add a new utility module',
        content: Buffer.from('module.exports = () => { console.log("New Utility"); };').toString('base64'),
        branch: 'master',
        ...(utilsSha && { sha: utilsSha })
    };
    await axios.put(`https://api.github.com/repos/${REPO}/contents/${utilsPath}`, featureBody, { headers });
    console.log('✅ Push complete. Check your email for the PDF report!');

    // TEST 2: BREAK DEPLOYMENT (SURGEON TEST)
    console.log('2. Breaking the workflow file...');
    const workflowPath = '.github/workflows/main.yml';
    let workflowRes;
    let workflowContent;
    let workflowSha;

    try {
        workflowRes = await axios.get(`https://api.github.com/repos/${REPO}/contents/${workflowPath}`, { headers });
        workflowContent = Buffer.from(workflowRes.data.content, 'base64').toString();
        workflowSha = workflowRes.data.sha;
    } catch (e) {
        console.log("   (Workflow not found, creating a new one...)");
        workflowContent = `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Hello"`;
        workflowSha = null;
    }
    
    // Inject a failure
    const brokenWorkflow = workflowContent + `\n      - name: Failure Step\n        run: exit 1\n`;
    
    await axios.put(`https://api.github.com/repos/${REPO}/contents/${workflowPath}`, {
        message: 'fix: update workflow with failure',
        content: Buffer.from(brokenWorkflow).toString('base64'),
        sha: workflowSha,
        branch: 'master'
    }, { headers });
    console.log('✅ Workflow broken. The Surgeon should wake up in a few minutes after the run fails.');

    // TEST 3: MERGE CONFLICT (MEDIATOR TEST)
    console.log('3. Creating a merge conflict...');
    const readmeFile = await axios.get(`https://api.github.com/repos/${REPO}/contents/README.md`, { headers });
    const originalSha = readmeFile.data.sha;
    const originalContent = Buffer.from(readmeFile.data.content, 'base64').toString();

    // Update Master
    console.log('3a. Updating Master...');
    await axios.put(`https://api.github.com/repos/${REPO}/contents/README.md`, {
        message: 'Update README on master',
        content: Buffer.from(originalContent + '\n\nCONTRADICTING LINE: A').toString('base64'),
        sha: originalSha,
        branch: 'master'
    }, { headers });

    // Create Branch from ORIGINAL state
    console.log('3b. Creating Branch from ORIGINAL state...');
    const masterRef = await axios.get(`https://api.github.com/repos/${REPO}/git/refs/heads/master`, { headers });
    const commitData = await axios.get(`https://api.github.com/repos/${REPO}/commits/${masterRef.data.object.sha}`, { headers });
    const parentSha = commitData.data.parents[0].sha;

    const branchName = 'conflict-test-' + Date.now();
    await axios.post(`https://api.github.com/repos/${REPO}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha: parentSha
    }, { headers });

    // Update Branch
    console.log('3c. Updating Branch (CONTRADICTING)...');
    const branchFile = await axios.get(`https://api.github.com/repos/${REPO}/contents/README.md?ref=${branchName}`, { headers });
    await axios.put(`https://api.github.com/repos/${REPO}/contents/README.md`, {
        message: 'Update README on branch',
        content: Buffer.from(originalContent + '\n\nCONTRADICTING LINE: B').toString('base64'),
        sha: branchFile.data.sha,
        branch: branchName
    }, { headers });

    // Open PR
    console.log('3d. Opening PR...');
    const pr = await axios.post(`https://api.github.com/repos/${REPO}/pulls`, {
        title: 'Conflict Test PR',
        head: branchName,
        base: 'master',
        body: 'Testing auto-conflict resolution'
    }, { headers });

    console.log(`✅ PR Created: ${pr.data.html_url}. Watch for the Agent to resolve and merge!`);
    console.log('--- TEST SUITE DISPATCHED ---');

  } catch (error) {
    console.error('Test Suite Failed:', error.response ? error.response.data : error.message);
  }
}

runTests();
