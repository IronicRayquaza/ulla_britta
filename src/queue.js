import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE_NAME = 'ulla_britta_events';

class QueueService {
    constructor() {
        this.client = new Redis(REDIS_URL);
        this.client.on('error', (err) => console.error('Redis Error:', err));
    }

    async enqueue(event) {
        console.log(`📥 Queuing event: ${event.type}`);
        await this.client.lpush(QUEUE_NAME, JSON.stringify(event));
    }

    async dequeue() {
        const result = await this.client.brpop(QUEUE_NAME, 0);
        if (result) {
            return JSON.parse(result[1]);
        }
        return null;
    }
}

export default new QueueService();
