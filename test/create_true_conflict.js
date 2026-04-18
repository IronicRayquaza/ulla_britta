const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const FILE_PATH = 'README.md';

async function createTrueConflict() {
  try {
    const headers = { Authorization: `token ${GITHUB_TOKEN}` };

    // 1. Get current README content and SHA from main
    console.log('Fetching state from main...');
    const { data: mainFile } = await axios.get(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      { headers }
    );
    const baseSha = mainFile.sha;
    const baseContent = Buffer.from(mainFile.content, 'base64').toString();

    // 2. Get the commit SHA of main
    const { data: refData } = await axios.get(`https://api.github.com/repos/${REPO}/git/refs/heads/main`, { headers });
    const mainSha = refData.object.sha;

    // 3. Create branch FIRST (from the current state)
    const branchName = 'final-conflict-' + Date.now();
    console.log(`Creating ${branchName} from ${mainSha}...`);
    await axios.post(
        `https://api.github.com/repos/${REPO}/git/refs`,
        { ref: `refs/heads/${branchName}`, sha: mainSha },
        { headers }
    );

    // 4. Update README on main branch
    console.log('Updating README on main...');
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Conflict source on main',
        content: Buffer.from(baseContent + '\n\nThis line was added on MAIN.').toString('base64'),
        sha: baseSha,
        branch: 'main'
      },
      { headers }
    );

    // 5. Update README on the new branch using the SAME base SHA
    console.log('Updating README on branch (creating conflict)...');
    await axios.put(
      `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
      {
        message: 'Conflict source on branch',
        content: Buffer.from(baseContent + '\n\nThis line was added on BRANCH.').toString('base64'),
        sha: baseSha, // Using the same base SHA creates the conflict
        branch: branchName
      },
      { headers }
    );

    // 6. Create Pull Request
    console.log('Creating PR...');
    const prResponse = await axios.post(
      `https://api.github.com/repos/${REPO}/pulls`,
      {
        title: 'TRUE Merge Conflict Test',
        head: branchName,
        base: 'main',
        body: 'This PR definitely has a conflict.'
      },
      { headers }
    );

    console.log(`Conflict created! PR: ${prResponse.data.html_url}`);
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
  }
}

createTrueConflict();
