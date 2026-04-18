const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const FILE_PATH = '.github/workflows/main.yml';

async function breakDeploy() {
  try {
    // 1. Get current file content and SHA
    const { data: fileData } = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    let content = Buffer.from(fileData.content, 'base64').toString();
    
    // 2. Add a failing deployment step
    const brokenContent = content + `
    - name: Deploy to Production
      run: |
        echo "Starting deployment..."
        echo "Error: SSL Certificate expired on production server"
        exit 1
`;

    // 3. Update the file
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Add fake deployment step for testing',
        content: Buffer.from(brokenContent).toString('base64'),
        sha: fileData.sha,
      },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );

    console.log('Successfully added a failing deployment step.');
  } catch (error) {
    console.error('Error breaking deployment:', error.response ? error.response.data : error.message);
  }
}

breakDeploy();
