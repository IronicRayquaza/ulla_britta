const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';

async function getRecentEvents() {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${REPO}/events?per_page=5`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    data.forEach(e => {
        console.log(`Type: ${e.type}, Created: ${e.created_at}`);
        if(e.payload.commits) {
            e.payload.commits.forEach(c => console.log(`  Commit: ${c.message}`));
        }
    });
  } catch (error) {
    console.error('Error fetching events:', error.response ? error.response.data : error.message);
  }
}

getRecentEvents();
