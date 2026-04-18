const axios = require('axios');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'IronicRayquaza/narrator_testing';
const RUN_ID = '24602554952';

async function fetchLogs() {
  try {
    const jobsUrl = `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/jobs`;
    const { data: jobsData } = await axios.get(jobsUrl, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });

    for (const job of jobsData.jobs) {
      console.log(`Job: ${job.name}, Status: ${job.status}, Conclusion: ${job.conclusion}`);
      if (job.conclusion === 'failure') {
        const logsUrl = `https://api.github.com/repos/${REPO}/actions/jobs/${job.id}/logs`;
        const { data: logs } = await axios.get(logsUrl, {
          headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
        console.log('--- LOGS (LAST 2000 CHARS) ---');
        console.log(logs.slice(-2000)); 
        console.log('--- END LOGS ---');
      }
    }
  } catch (error) {
    console.error('Error fetching logs:', error.response ? error.response.data : error.message);
  }
}

fetchLogs();
