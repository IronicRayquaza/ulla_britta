/** Minimal assertion harness — no dependencies, readable output. */
let failures = 0;
let total = 0;

export function check(label, condition, detail = null) {
    total++;
    if (condition) {
        console.log(`  PASS  ${label}`);
    } else {
        failures++;
        console.log(`  FAIL  ${label}`);
        if (detail !== null) console.log(`        got: ${JSON.stringify(detail)}`);
    }
}

export function report(suiteName) {
    console.log(failures === 0
        ? `\n  ${total}/${total} passed — ${suiteName}`
        : `\n  ${failures} of ${total} FAILED — ${suiteName}`);
    process.exit(failures === 0 ? 0 : 1);
}
