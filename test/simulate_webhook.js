const axios = require('axios');
const crypto = require('crypto');

const WEBHOOK_SECRET = 'development_secret';
const WEBHOOK_URL = 'http://localhost:3000/webhook';

const payload = {
  repository: {
    full_name: 'test-user/test-repo'
  },
  commits: [
    {
      id: 'a1b2c3d4e5f6g7h8i9j0',
      message: 'feat: add user authentication system',
      author: { name: 'Alice Developer' },
      timestamp: new Date().toISOString()
    },
    {
      id: 'k1l2m3n4o5p6q7r8s9t0',
      message: 'fix: resolve memory leak in database connection pool',
      author: { name: 'Bob Engineer' },
      timestamp: new Date().toISOString()
    }
  ]
};

const body = JSON.stringify(payload);
const signature = `sha256=${crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(body)
  .digest('hex')}`;

async function simulate() {
  try {
    console.log('Sending mock webhook push event...');
    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signature,
        'X-GitHub-Delivery': crypto.randomUUID()
      }
    });
    console.log('Response Status:', response.status);
    console.log('Response Data:', response.data);
  } catch (error) {
    console.error('Error simulating webhook:', error.response ? error.response.data : error.message);
  }
}

simulate();
