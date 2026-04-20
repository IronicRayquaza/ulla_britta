const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/ulla_britta_test';
const headers = { Authorization: `token ${GITHUB_TOKEN}` };

async function injectFailure() {
    try {
        console.log('Injecting deliberate failure...');

        // 1. Create/Update main.js with a bug
        const mainContent = `
/**
 * This is a critical production module.
 * It currently has a bug that causes it to exit prematurely.
 */
console.log("Initializing system...");
console.log("Checking data integrity...");

// BUG: Forced crash
process.exit(1); 
`;
        
        let mainSha;
        try {
            const res = await axios.get(`https://api.github.com/repos/${REPO}/contents/main.js`, { headers });
            mainSha = res.data.sha;
        } catch (e) {}

        await axios.put(`https://api.github.com/repos/${REPO}/contents/main.js`, {
            message: 'feat: add core logic',
            content: Buffer.from(mainContent).toString('base64'),
            sha: mainSha,
            branch: 'master'
        }, { headers });

        console.log('✅ main.js updated with bug.');

        // 2. Setup Workflow
        const workflowContent = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup Node
        uses: actions/setup-node@v2
        with:
          node-version: '18'
      - name: Run Main Script
        run: node main.js
`;
        
        let workflowSha;
        try {
            const res = await axios.get(`https://api.github.com/repos/${REPO}/contents/.github/workflows/main.yml`, { headers });
            workflowSha = res.data.sha;
        } catch (e) {}

        await axios.put(`https://api.github.com/repos/${REPO}/contents/.github/workflows/main.yml`, {
            message: 'chore: update ci workflow',
            content: Buffer.from(workflowContent).toString('base64'),
            sha: workflowSha,
            branch: 'master'
        }, { headers });

        console.log('✅ Workflow updated. Failure incoming!');
    } catch (error) {
        console.error('Failed to inject failure:', error.response ? error.response.data : error.message);
    }
}

injectFailure();
