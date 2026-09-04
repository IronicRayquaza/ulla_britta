import queueService from './queue.mjs';
import { processEvent } from './processor.mjs';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED = ['GEMINI_API_KEY', 'REDIS_URL'];
REQUIRED.forEach(v => {
    if (!process.env[v]) {
        // Render provides Redis as REDIS_INTERNAL_URL.
        if (v === 'REDIS_URL' && process.env.REDIS_INTERNAL_URL) return;
        throw new Error(`Missing ${v}`);
    }
});

const QUEUE_NAME = 'ulla_britta_events';
const FAILED_QUEUE = 'ulla_britta_failed';
const MAX_ATTEMPTS = 3;

console.log('🤖 Ulla Britta Worker is standing by...');

let isShuttingDown = false;
let currentTask = null;

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received. Finishing the current task before exiting...');
    isShuttingDown = true;

    let waited = 0;
    while (currentTask && waited < 30) {
        await new Promise(r => setTimeout(r, 1000));
        waited++;
    }
    if (currentTask) {
        console.warn('⚠️ Exiting with a task still running; it will be retried from the queue.');
    }
    process.exit(0);
});

async function startWorker() {
    while (!isShuttingDown) {
        try {
            const event = await queueService.dequeue();
            if (!event) continue;

            currentTask = event;
            const attempt = (event.retryCount || 0) + 1;
            console.log(`\n🧵 ${event.type} (${event.id}) attempt ${attempt}/${MAX_ATTEMPTS}`);

            await processEvent(event);
            console.log(`✅ ${event.id} done`);
            currentTask = null;
        } catch (error) {
            console.error(`❌ Task failed: ${error.message}`);
            if (currentTask) {
                await handleFailure(currentTask, error);
                currentTask = null;
            }
        }
    }
}

/**
 * Retries with exponential backoff.
 *
 * The previous version re-enqueued immediately and slept a flat 5s in the loop, so
 * a task failing against a rate-limited API would burn all three attempts inside
 * fifteen seconds and land in a dead-letter queue nothing ever read.
 */
async function handleFailure(event, error) {
    event.retryCount = (event.retryCount || 0) + 1;
    event.lastError = error.message;

    if (event.retryCount < MAX_ATTEMPTS) {
        const delayMs = Math.min(2 ** event.retryCount * 1000, 30_000);
        console.warn(`🔄 Retrying ${event.id} in ${delayMs / 1000}s (attempt ${event.retryCount + 1}/${MAX_ATTEMPTS})`);

        // Delay before re-queueing so the retry does not immediately come back round.
        setTimeout(() => {
            queueService.client
                .lpush(QUEUE_NAME, JSON.stringify(event))
                .catch(e => console.error(`Could not re-queue ${event.id}: ${e.message}`));
        }, delayMs);
        return;
    }

    console.error(`💀 ${event.id} failed after ${MAX_ATTEMPTS} attempts: ${error.message}`);
    await queueService.client.lpush(FAILED_QUEUE, JSON.stringify({
        event,
        error: error.message,
        failedAt: new Date().toISOString()
    }));

    // Keep the dead-letter queue bounded; it is a diagnostic buffer, not storage.
    await queueService.client.ltrim(FAILED_QUEUE, 0, 199);
}

startWorker();
