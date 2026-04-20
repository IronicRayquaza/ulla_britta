import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🌟 Starting Ulla Britta in SOLO MODE (Receiver + Worker)...');

// Start the Ingestion Tier
const receiver = fork(path.join(__dirname, 'index.mjs'));

// Start the Processing Tier
const worker = fork(path.join(__dirname, 'worker.mjs'));

receiver.on('exit', (code) => {
  console.error(`❌ Receiver exited with code ${code}`);
  process.exit(code);
});

worker.on('exit', (code) => {
  console.error(`❌ Worker exited with code ${code}`);
  process.exit(code);
});

console.log('✅ Both tiers are running in parallel.');
