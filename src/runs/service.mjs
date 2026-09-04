import store from './store.mjs';
import bus from './bus.mjs';
import { enqueueTask } from '../queue.mjs';
import agentService from '../agent/index.mjs';

/**
 * Run lifecycle.
 *
 * createRun() is called by the web process; executeRun() by the worker. They share
 * nothing but Redis and Postgres, so a run survives the web process restarting,
 * and a long task is no longer bounded by an HTTP request timeout.
 */

/** How often the loop checks whether a cancel has been requested. */
const CANCEL_POLL_STEPS = 1;

export async function createRun(userId, message, budget = {}) {
    const run = await store.createRun({ userId, input: message, budget });
    await enqueueTask('chat_run', { runId: run.id, userId, message, budget });
    return run;
}

/**
 * Executes a queued run. Called from the worker.
 *
 * Every step is persisted and published as it happens, so a browser attached to the
 * stream sees the work live and a browser that reloads can replay it.
 */
export async function executeRun({ runId, userId, message, budget = {} }) {
    await store.markRunning(runId);
    await bus.clearCancel(runId);

    let seq = 0;
    let stepsSinceCancelCheck = 0;

    // Steps a previous attempt already applied. A retried task must not push the
    // same file or open the same PR twice.
    const alreadyApplied = await store.appliedSteps(runId);

    const onEvent = async (event) => {
        const currentSeq = seq++;

        // Persist and broadcast in parallel; neither should block the other.
        await Promise.allSettled([
            store.recordStep(runId, userId, currentSeq, event),
            bus.publish(runId, { ...event, seq: currentSeq, runId })
        ]);

        // Cancellation is cooperative: the flag is set by the web process and read
        // here between steps, so a cancelled run stops cleanly rather than being
        // killed mid-write.
        stepsSinceCancelCheck++;
        if (stepsSinceCancelCheck >= CANCEL_POLL_STEPS) {
            stepsSinceCancelCheck = 0;
            if (await bus.isCancelled(runId)) {
                agentService.cancel(runId, 'Cancelled from the dashboard');
            }
        }
    };

    try {
        const result = await agentService.processMessage(userId, message, {
            runId,
            budget,
            onEvent,
            alreadyApplied
        });

        await store.finishRun(runId, {
            stopReason: result.stopReason,
            text: result.text,
            usage: result.budget
        });

        await bus.publish(runId, {
            type: 'run_complete',
            runId,
            seq: seq++,
            ok: result.ok,
            stopReason: result.stopReason,
            text: result.text,
            performed: result.performed
        });

        return result;
    } catch (err) {
        await store.finishRun(runId, {
            stopReason: 'error',
            text: null,
            error: err.message
        });

        await bus.publish(runId, {
            type: 'run_complete',
            runId,
            seq: seq++,
            ok: false,
            stopReason: 'error',
            text: `The run failed: ${err.message}`,
            performed: []
        });

        throw err;
    } finally {
        await bus.clearCancel(runId);
    }
}

export async function cancelRun(runId, userId) {
    // Only the owner may cancel, and only a run that is still going.
    const run = await store.getRun(runId, userId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) {
        return { cancelled: false, reason: `This run already ${run.status}.` };
    }

    // Also cancel in-process, in case the run is executing here (solo mode).
    agentService.cancel(runId, 'Cancelled from the dashboard');
    const signalled = await bus.requestCancel(runId);

    return signalled
        ? { cancelled: true }
        : { cancelled: false, reason: 'Could not reach the worker to cancel this run.' };
}

export { store, bus };
