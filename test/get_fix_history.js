const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';

async function getFixHistory() {
  try {
    const { data: commits } = await axios.get(
      `https://api.github.com/repos/${REPO}/commits?per_page=3`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    for (let c of commits) {
        console.log(`SHA: ${c.sha}`);
        console.log(`Message: ${c.commit.message}`);
        const { data: diffData } = await axios.get(
          `https://api.github.com/repos/${REPO}/commits/${c.sha}`,
          { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3.diff' } }
        );
        console.log('--- DIFF ---');
        console.log(diffData);
        console.log('====================================');
    }
  } catch (error) {
    console.error('Error fetching fix details:', error.response ? error.response.data : error.message);
  }
}

getFixHistory();
