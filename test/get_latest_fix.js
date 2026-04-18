const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';

async function getLatestFix() {
  try {
    const { data: commits } = await axios.get(
      `https://api.github.com/repos/${REPO}/commits?per_page=1`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    const latestCommit = commits[0];
    const { data: diffData } = await axios.get(
      `https://api.github.com/repos/${REPO}/commits/${latestCommit.sha}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3.diff' } }
    );

    console.log('--- COMMIT MESSAGE ---');
    console.log(latestCommit.commit.message);
    console.log('\n--- DIFF ---');
    console.log(diffData);
  } catch (error) {
    console.error('Error fetching fix details:', error.response ? error.response.data : error.message);
  }
}

getLatestFix();
