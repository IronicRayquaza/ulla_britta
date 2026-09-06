import queueService from './queue.mjs';
import { processEvent } from './processor.mjs';
import vercelSentinel from './services/vercel-sentinel.service.mjs';
import dotenv from 'dotenv';
import router from './providers/index.mjs';
import { checkModelsInBackground } from './providers/preflight.mjs';

dotenv.config();

// At least one model provider is required. Gemini is the default, but a Groq-only
// deployment is a supported configuration, so demanding GEMINI_API_KEY specifically
// would refuse to start a setup that works.
if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
        'No model provider configured. Set at least one of GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY.'
    );
}

// Redis has a working localhost default in queue.mjs, so an unset URL is a
// development convenience rather than a fatal error. In production it almost
// certainly means the service was not wired up, so say so loudly.
if (!process.env.REDIS_URL && !process.env.REDIS_INTERNAL_URL) {
    const message = 'REDIS_URL is not set; falling back to redis://localhost:6379.';
    if (process.env.NODE_ENV === 'production') {
        throw new Error(`${message} Refusing to start in production without a queue.`);
    }
    console.warn(`⚠️ ${message}`);
}

const QUEUE_NAME = 'ulla_britta_events';
const FAILED_QUEUE = 'ulla_britta_failed';
const MAX_ATTEMPTS = 3;

console.log('🤖 Ulla Britta Worker is standing by...');

let isShuttingDown = false;

/**
 * The Vercel Sentinel lives here rather than in the web process: it polls, and
 * then does long repair work. A web dyno that sleeps between requests would never
 * run it reliably, and a request-serving process is the wrong place for it anyway.
 */
const SENTINEL_INTERVAL_MS = Number(process.env.SENTINEL_INTERVAL_MS || 2 * 60 * 1000);
let sentinelRunning = false;

async function runSentinel() {
    // Never overlap: a slow pass must not start a second one on top of itself.
    if (sentinelRunning || isShuttingDown) return;
    sentinelRunning = true;
    try {
        await vercelSentinel.checkForFailures();
    } catch (err) {
        console.error(`Sentinel error: ${err.message}`);
    } finally {
        sentinelRunning = false;
    }
}

if (process.env.DISABLE_SENTINEL !== 'true') {
    setInterval(runSentinel, SENTINEL_INTERVAL_MS).unref();
    runSentinel();
}

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

// Same catalogue check the receiver runs. The worker is where agent runs actually
// execute, so a rotted model name matters most here.
checkModelsInBackground(router);

startWorker();
