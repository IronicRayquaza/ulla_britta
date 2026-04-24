import Redis from 'ioredis';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const REDIS_URL = process.env.REDIS_INTERNAL_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE_NAME = 'ulla_britta_events';

class QueueService {
    constructor() {
        this.client = new Redis(REDIS_URL);
        this.client.on('error', (err) => console.error('Redis Error:', err));
    }

    async enqueue(type, payload) {
        const taskId = uuidv4();
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
