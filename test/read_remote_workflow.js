const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const FILE_PATH = '.github/workflows/main.yml';

async function readFile() {
  try {
    const { data } = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    console.log(Buffer.from(data.content, 'base64').toString());
  } catch (error) {
    console.error('Error reading file:', error.response ? error.response.data : error.message);
  }
}

readFile();
