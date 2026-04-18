const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WEBHOOK_SECRET = 'development_secret';
const WEBHOOK_URL = 'http://localhost:3000/webhook';

// Use the payload provided by the user (simulated if file doesn't exist)
let payload = {};
const payloadPath = path.join(__dirname, 'last_payload.json');

const pushPath = path.join(__dirname, 'push_payload.json');

if (fs.existsSync(payloadPath)) {
  payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
} else if (fs.existsSync(pushPath)) {
  payload = JSON.parse(fs.readFileSync(pushPath, 'utf8'));
} else {
  console.log('No payload found. Please create test/last_payload.json or test/push_payload.json.');
  process.exit(1);
}

const body = JSON.stringify(payload);
const signature = `sha256=${crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(body)
  .digest('hex')}`;

async function simulate() {
  try {
    console.log('Sending manual payload to local server...');
    const response = await axios.post(WEBHOOK_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': payload.zen ? 'ping' : 'push',
        'X-Hub-Signature-256': signature,
        'X-GitHub-Delivery': crypto.randomUUID()
      }
    });
    console.log('Response Status:', response.status);
    console.log('Response Data:', response.data);
    console.log('Now check your server log to see the background processing!');
  } catch (error) {
    console.error('Error simulating webhook:', error.response ? error.response.data : error.message);
  }
}

simulate();
