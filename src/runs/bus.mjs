import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_INTERNAL_URL || process.env.REDIS_URL || 'redis://localhost:6379';

const channelFor = (runId) => `ulla:run:${runId}:events`;
const cancelKeyFor = (runId) => `ulla:run:${runId}:cancel`;

/**
 * Live event bus for runs.
 *
 * Runs execute in the worker process while the browser is connected to the web
 * process, so events cross a process boundary. Redis pub/sub carries them, and a
 * cancel flag travels the other way.
 *
 * A subscriber connection cannot issue normal commands, so publishing and
 * subscribing use separate connections.
 */
class RunBus {
    constructor() {
        this.publisher = null;
        this.enabled = true;
    }

    connection() {
        if (!this.publisher) {
            this.publisher = new Redis(REDIS_URL, {
                retryStrategy: (times) => Math.min(times * 500, 10_000),
                maxRetriesPerRequest: 3
            });
            this.publisher.on('error', () => { /* reported once by queue.mjs */ });
        }
        return this.publisher;
    }

    /** Publishes one step. Never throws: losing a stream frame must not kill a run. */
    async publish(runId, event) {
        try {
            await this.connection().publish(channelFor(runId), JSON.stringify(event));
        } catch {
            // The run continues; the step is still persisted and readable on reload.
        }
    }

    /**
     * Subscribes to a run's events.
     * @returns {Promise<Function>} call it to unsubscribe and close the connection.
     */
    async subscribe(runId, onEvent) {
        const sub = new Redis(REDIS_URL, {
            retryStrategy: (times) => Math.min(times * 500, 10_000)
        });
        sub.on('error', () => {});

        await sub.subscribe(channelFor(runId));
        sub.on('message', (_channel, payload) => {
            try {
                onEvent(JSON.parse(payload));
            } catch {
                // Ignore an unparseable frame rather than tearing down the stream.
            }
        });

        return async () => {
            try {
                await sub.unsubscribe(channelFor(runId));
            } finally {
                sub.disconnect();
            }
        };
    }

    /** Raises the cancel flag the worker checks between steps. */
    async requestCancel(runId, reason = 'Cancelled by user') {
        try {
            // Expires on its own so a cancel for a run that never starts cannot linger.
            await this.connection().set(cancelKeyFor(runId), reason, 'EX', 3600);
            return true;
        } catch {
            return false;
        }
    }

    async isCancelled(runId) {
        try {
            return (await this.connection().get(cancelKeyFor(runId))) !== null;
        } catch {
            return false;
        }
    }

    async clearCancel(runId) {
        try {
            await this.connection().del(cancelKeyFor(runId));
        } catch {
            // Nothing to do; the key expires anyway.
        }
    }
}

export default new RunBus();
