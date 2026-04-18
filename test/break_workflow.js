const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const FILE_PATH = '.github/workflows/main.yml';

async function breakWorkflow() {
  try {
    // 1. Get current file content and SHA
    const { data: fileData } = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    let content = Buffer.from(fileData.content, 'base64').toString();
    
    // 2. Introduce a new error (misspelling 'node' or something similar)
    // Looking for the part to replace
    const brokenContent = content.replace(/run: node .*/, 'run: npx non-existent-command-xyz');

    // 3. Update the file
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Introduce intentional workflow error for testing',
        content: Buffer.from(brokenContent).toString('base64'),
        sha: fileData.sha,
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    console.log('Successfully broke the workflow with a non-existent command.');
  } catch (error) {
    console.error('Error breaking workflow:', error.response ? error.response.data : error.message);
  }
}

breakWorkflow();
