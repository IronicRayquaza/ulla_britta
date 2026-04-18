const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';

async function checkWorkflow() {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${REPO}/actions/runs?per_page=1`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    const run = data.workflow_runs[0];
    console.log(`Latest Run ID: ${run.id}`);
    console.log(`Status: ${run.status}`);
    console.log(`Conclusion: ${run.conclusion}`);
    console.log(`Message: ${run.head_commit.message}`);
  } catch (error) {
    console.error('Error checking workflow:', error.response ? error.response.data : error.message);
  }
}

checkWorkflow();
