const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const FILE_PATH = 'README.md';

async function createConflict() {
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
        message: 'Update README on main',
        content: Buffer.from(originalContent + '\n\nChanged on Main Branch').toString('base64'),
        sha: mainFile.sha,
        branch: 'main'
      },
      { headers }
    );

    // 3. Create a new branch from the OLD sha (before the main update)
    console.log('Creating conflict-branch...');
    const { data: refData } = await axios.get(`https://api.github.com/repos/${REPO}/git/refs/heads/main`, { headers });
    // Note: We should ideally use the SHA from BEFORE the update we just did, 
    // but for simplicity, we'll just create a branch and then edit the same line.
    
    await axios.post(
        `https://api.github.com/repos/${REPO}/git/refs`,
        { ref: 'refs/heads/conflict-branch', sha: refData.object.sha },
        { headers }
      ).catch(e => console.log('Branch might already exist, continuing...'));

    // 4. Update README on conflict-branch with a different change on the same line
    console.log('Updating README on conflict-branch...');
    const { data: branchFile } = await axios.get(
        `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=conflict-branch`,
        { headers }
      );
    
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Update README on conflict-branch',
        content: Buffer.from(originalContent + '\n\nChanged on Conflict Branch').toString('base64'),
        sha: branchFile.sha,
        branch: 'conflict-branch'
      },
      { headers }
    );

    // 5. Create Pull Request
    console.log('Creating Pull Request...');
    const prResponse = await axios.post(
      `https://api.github.com/repos/${REPO}/pulls`,
      {
        title: 'Test Conflict PR',
        head: 'conflict-branch',
        base: 'main',
        body: 'This PR should have a merge conflict.'
      },
      { headers }
    );

    console.log(`Conflict created! PR: ${prResponse.data.html_url}`);
  } catch (error) {
    console.error('Error creating conflict:', error.response ? error.response.data : error.message);
  }
}

createConflict();
