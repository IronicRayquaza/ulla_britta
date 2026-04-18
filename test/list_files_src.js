const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';

async function listFiles(path) {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${path}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    console.log(JSON.stringify(data.map(f => f.path), null, 2));
  } catch (error) {
    console.error('Error listing files:', error.response ? error.response.data : error.message);
  }
}

listFiles('src');
