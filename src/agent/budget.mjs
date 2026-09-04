/**
 * Run budget and cancellation.
 *
 * The old loop stopped after exactly 3 rounds, which cut off any task that needed
 * look → act → verify → correct. A real agent should run until the work is done or
 * a resource genuinely runs out, so stopping is expressed as a budget instead.
 */
export class Budget {
    constructor({ maxSteps = 25, maxTokens = 250_000, deadlineMs = 10 * 60 * 1000 } = {}) {
        this.maxSteps = maxSteps;
        this.maxTokens = maxTokens;
        this.deadlineMs = deadlineMs;

        this.steps = 0;
        this.tokens = 0;
        this.startedAt = Date.now();
        this.cancelled = false;
        this.cancelReason = null;
    }

    cancel(reason = 'Cancelled by user') {
        this.cancelled = true;
        this.cancelReason = reason;
    }

    countStep() { this.steps++; }
    countTokens(n = 0) { this.tokens += n; }

    get elapsedMs() { return Date.now() - this.startedAt; }
    get remainingSteps() { return Math.max(0, this.maxSteps - this.steps); }

    /**
     * @returns {null | { reason, message }} null while the run may continue.
     */
    exhausted() {
        if (this.cancelled) {
            return { reason: 'cancelled', message: this.cancelReason };
        }
        if (this.steps >= this.maxSteps) {
            return {
                reason: 'max_steps',
                message: `Reached the step limit (${this.maxSteps}) before finishing.`
            };
        }
        if (this.tokens >= this.maxTokens) {
            return {
                reason: 'max_tokens',
                message: `Reached the token budget (${this.maxTokens}) before finishing.`
            };
        }
        if (this.elapsedMs >= this.deadlineMs) {
            return {
                reason: 'deadline',
                message: `Ran out of time after ${Math.round(this.elapsedMs / 1000)}s.`
            };
        }
        return null;
    }

    snapshot() {
        return {
            steps: this.steps,
            maxSteps: this.maxSteps,
            tokens: this.tokens,
            elapsedMs: this.elapsedMs
        };
    }
}

export default Budget;
