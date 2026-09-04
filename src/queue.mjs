import Redis from 'ioredis';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

const REDIS_URL = process.env.REDIS_INTERNAL_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE_NAME = 'ulla_britta_events';

class QueueService {
    constructor() {
        this.client = new Redis(REDIS_URL, {
            // Back off instead of hammering, and cap the delay so recovery stays quick.
            retryStrategy: (times) => Math.min(times * 500, 10_000),
            maxRetriesPerRequest: 3
        });

        // ioredis retries forever by default and logs the full AggregateError each
        // time, which buries every other line in the log. Report the first failure
        // and each recovery, then stay quiet while it retries.
        this.connected = false;
        this.errorReported = false;

        this.client.on('error', (err) => {
            if (!this.errorReported) {
                console.error(`❌ Redis unavailable (${REDIS_URL}): ${err.message}. Retrying in the background...`);
                this.errorReported = true;
            }
            this.connected = false;
        });

        this.client.on('ready', () => {
            if (!this.connected) console.log('✅ Redis connected.');
            this.connected = true;
            this.errorReported = false;
        });
    }

    async enqueue(type, payload) {
        const taskId = randomUUID();
        const task = { id: taskId, type, payload, timestamp: new Date().toISOString() };
        await this.client.lpush(QUEUE_NAME, JSON.stringify(task));
        return taskId;
    }

    async dequeue() {
        const result = await this.client.brpop(QUEUE_NAME, 0);
        if (result) {
            return JSON.parse(result[1]);
        }
        return null;
    }
}

const queue = new QueueService();
export const enqueueTask = (type, payload) => queue.enqueue(type, payload);
export const dequeueTask = () => queue.dequeue();
export default queue;
