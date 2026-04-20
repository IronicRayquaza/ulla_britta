import queueService from './queue.js';
import { processEvent } from './processor.js';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED = ['GEMINI_API_KEY', 'REDIS_URL'];
REQUIRED.forEach(v => { if (!process.env[v]) throw new Error(`Missing ${v}`) });

console.log('🤖 Ulla Britta Worker is standing by...');

let isShuttingDown = false;
let currentTask = null;

process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM. Shutting down gracefully...');
    isShuttingDown = true;
    let waited = 0;
    while (currentTask && waited < 30) {
        await new Promise(r => setTimeout(r, 1000));
        waited++;
    }
    process.exit(0);
});

async function startWorker() {
    while (!isShuttingDown) {
        try {
            const event = await queueService.dequeue();
            if (event) {
                currentTask = event;
                console.log(`\n🧵 Task: ${event.type} (${event.id}) | Attempt: ${event.retryCount + 1}`);
                await processEvent(event);
                console.log(`✅ Success: ${event.id}`);
                currentTask = null;
            }
        } catch (error) {
            console.error('❌ Task Error:', error.message);
            if (currentTask) {
                await handleFailure(currentTask, error);
                currentTask = null;
            }
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

async function handleFailure(event, error) {
    event.retryCount = (event.retryCount || 0) + 1;
    if (event.retryCount < 3) {
        console.warn(`🔄 Retrying task ${event.id}...`);
        await queueService.enqueue(event);
    } else {
        console.error(`💀 Task ${event.id} FAILED after 3 attempts.`);
        await queueService.client.lpush('ulla_britta_failed', JSON.stringify({
            event,
            error: error.message,
            failedAt: new Date().toISOString()
        }));
    }
}

startWorker();
