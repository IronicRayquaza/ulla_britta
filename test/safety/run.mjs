/**
 * Safety regression suite.
 *
 * These cover the properties that must never regress:
 *  1. Provider adapters represent the same conversation faithfully, so failing
 *     over mid-run does not drop the work already done.
 *  2. The loop runs as many steps as the work needs and stops on a budget, not on
 *     a fixed round count.
 *  3. An irreversible tool cannot run without an explicit confirmation from a
 *     later user turn (so the agent cannot confirm its own destructive action).
 *  4. The agent never reports success for work it did not perform.
 *
 * Each suite runs in its own process because they patch module singletons.
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = [
    'providers.test.mjs',
    'agent-loop.test.mjs',
    'destructive-gate.test.mjs',
    'honest-failure.test.mjs'
];

let failed = 0;
for (const suite of suites) {
    console.log(`\n=== ${suite} ===`);
    const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}

console.log(failed === 0 ? '\n✅ All safety suites passed.' : `\n❌ ${failed} suite(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
