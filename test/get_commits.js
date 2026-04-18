const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';

async function getCommits() {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${REPO}/commits?per_page=5`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    data.forEach(c => {
        console.log(`SHA: ${c.sha}, Author: ${c.commit.author.name}, Message: ${c.commit.message}`);
    });
  } catch (error) {
    console.error('Error fetching commits:', error.response ? error.response.data : error.message);
  }
}

getCommits();
