const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const FILE_PATH = 'README.md';

async function createAutoMergeConflict() {
  try {
    const headers = { Authorization: `token ${GITHUB_TOKEN}` };

    // 1. Get current README content from main
    console.log('Fetching README from main...');
    const { data: mainFile } = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      { headers }
    );
    const originalContent = Buffer.from(mainFile.content, 'base64').toString();

    // 2. Update README on main branch
    console.log('Updating README on main...');
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Update README on main for auto-merge test',
        content: Buffer.from(originalContent + '\n\nForce Conflict - Main Side').toString('base64'),
        sha: mainFile.sha,
        branch: 'main'
      },
      { headers }
    );

    // 3. Create a new branch
    console.log('Creating auto-merge-branch...');
    const { data: refData } = await axios.get(`https://api.github.com/repos/${REPO}/git/refs/heads/main`, { headers });
    
    await axios.post(
        `https://api.github.com/repos/${REPO}/git/refs`,
        { ref: 'refs/heads/auto-merge-branch', sha: refData.object.sha },
        { headers }
      ).catch(e => console.log('Branch might already exist, continuing...'));

    // 4. Update README on auto-merge-branch with a conflict
    console.log('Updating README on auto-merge-branch...');
    const { data: branchFile } = await axios.get(
        `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=auto-merge-branch`,
        { headers }
      );
    
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Update README on auto-merge-branch',
        content: Buffer.from(originalContent + '\n\nForce Conflict - Branch Side').toString('base64'),
        sha: branchFile.sha,
        branch: 'auto-merge-branch'
      },
      { headers }
    );

    // 5. Create Pull Request
    console.log('Creating Pull Request...');
    const prResponse = await axios.post(
      `https://api.github.com/repos/${REPO}/pulls`,
      {
        title: 'Auto-Merge Conflict Test',
        head: 'auto-merge-branch',
        base: 'main',
        body: 'Testing auto-resolution and auto-merge.'
      },
      { headers }
    );

    console.log(`Conflict created! PR: ${prResponse.data.html_url}`);
  } catch (error) {
    console.error('Error creating conflict:', error.response ? error.response.data : error.message);
  }
}

createAutoMergeConflict();
