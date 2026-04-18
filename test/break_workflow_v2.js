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
    
    // 2. Introduce a script error
    // Search for the run command and replace it
    const brokenContent = content.replace(/run: node .*/, 'run: node -e "console.log(\'Database check failed\'); process.exit(1)"');

    // 3. Update the file
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Introduce script failure for AI testing',
        content: Buffer.from(brokenContent).toString('base64'),
        sha: fileData.sha,
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    console.log('Successfully broke the workflow with a script error.');
  } catch (error) {
    console.error('Error breaking workflow:', error.response ? error.response.data : error.message);
  }
}

breakWorkflow();
