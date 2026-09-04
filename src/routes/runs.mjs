import express from 'express';
import requireAuth, { verifyToken } from '../middleware/auth.mjs';
import { createRun, cancelRun, store, bus } from '../runs/service.mjs';

/**
 * Run API.
 *
 * A message starts a run and returns immediately; the browser watches it over SSE.
 * The old design blocked on a single POST, so anything that took minutes — a repo
 * scaffold, a PR fix — died on Render's request timeout with nothing recorded.
 */
const router = express.Router();

// ── Start a run ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
    const { message, budget } = req.body;

    if (typeof message !== 'string' || message.trim() === '') {
        return res.status(400).json({ error: 'A non-empty message is required.' });
    }

    try {
        const run = await createRun(req.auth.userId, message.trim(), budget || {});
        res.status(202).json({ runId: run.id, status: run.status });
    } catch (err) {
        console.error('Failed to start run:', err.message);
        res.status(503).json({
            error: `Could not start the run: ${err.message}`,
            hint: 'The task queue may be unavailable. Check that Redis is reachable.'
        });
    }
});

// ── Run history ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json({ runs: await store.listRuns(req.auth.userId, limit) });
});

// ── One run, with its steps ─────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
    const run = await store.getRun(req.params.id, req.auth.userId);
    if (!run) return res.status(404).json({ error: 'No such run.' });

    const steps = await store.getSteps(req.params.id, req.auth.userId);
    res.json({ run, steps });
});

// ── Cancel ──────────────────────────────────────────────────────────────────
router.post('/:id/cancel', requireAuth, async (req, res) => {
    const result = await cancelRun(req.params.id, req.auth.userId);
    res.status(result.cancelled ? 202 : 409).json(result);
});

// ── Live stream ─────────────────────────────────────────────────────────────
/**
 * EventSource cannot send an Authorization header, so the token arrives as a query
 * parameter here. It is verified exactly the same way, and the run is still checked
 * against the resulting user.
 */
router.get('/:id/stream', async (req, res) => {
    const token = req.query.token
        || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized.' });

    const runId = req.params.id;
    const userId = user.id;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'   // stop proxies buffering the stream
    });

    const send = (event) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let closed = false;
    let unsubscribe = null;
    let heartbeat = null;

    const cleanup = async () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (unsubscribe) await unsubscribe().catch(() => {});
        if (!res.writableEnded) res.end();
    };

    req.on('close', cleanup);

    try {
        // Subscribe before replaying, so a step that lands mid-replay is not missed.
        const seen = new Set();
        const emit = (event) => {
            if (event.seq !== undefined) {
                if (seen.has(event.seq)) return;   // replay and live stream can overlap
                seen.add(event.seq);
            }
            send(event);
            // The run is over; close rather than holding an idle connection open.
            if (event.type === 'run_complete' && !event.replayed) cleanup();
        };

        unsubscribe = await bus.subscribe(runId, emit);

        // Replay what already happened, so a reload or a late join sees the whole run.
        const run = await store.getRun(runId, userId);
        if (!run) {
            send({ type: 'error', message: 'No such run.' });
            return cleanup();
        }

        send({ type: 'run_state', run: { id: run.id, status: run.status, input: run.input } });
        for (const step of await store.getSteps(runId, userId)) {
            emit({
                type: step.type,
                seq: step.seq,
                name: step.tool_name,
                args: step.args,
                result: step.result,
                ok: step.ok,
                replayed: true
            });
        }

        // A run that already finished gets its ending immediately and the stream closes.
        if (['completed', 'failed', 'cancelled', 'incomplete'].includes(run.status)) {
            send({
                type: 'run_complete',
                ok: run.status === 'completed',
                stopReason: run.stop_reason,
                text: run.result || run.error,
                replayed: true
            });
            return cleanup();
        }

        // Keep intermediaries from closing an idle connection.
        heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
        }, 15_000);
    } catch (err) {
        send({ type: 'error', message: err.message });
        await cleanup();
    }
});

export default router;
