const base = '../../src/services/';
const chatService = (await import(base + 'chat.service.mjs')).default;
const aiGateway   = (await import(base + 'ai.service.mjs')).default;
const db          = (await import(base + 'database.service.mjs')).default;
const logger      = (await import(base + 'logger.service.mjs')).default;

// Keep the test offline and quiet.
db.getRecentActivity = async () => [];
db.getInstallationIdByRepo = async () => null;
logger.log = async () => {};

let failures = 0;
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) { failures++; console.log('    got: ' + JSON.stringify(got)); }
};

// Force the primary model to look rate-limited.
const rateLimited = () => {
  const e = new Error('429 Too Many Requests: rate limit exceeded');
  e.status = 429;
  throw e;
};
chatService.model = { startChat: () => ({ sendMessage: rateLimited }) };
chatService.sessions.clear();

// ── Case 1: the backup provider wants to run tools it cannot execute ──────────
aiGateway.agentChat = async () => ({
  text: '',
  toolCalls: [{ function: { name: 'delete_repository' } }],
  provider: 'groq'
});
const r1 = await chatService.processMessage('u1', 'delete my old test repo');
check('does not claim success when nothing ran', !r1.includes('✅'), r1);
check('says it could not complete the task', /could not complete/i.test(r1), r1);
check('states plainly that nothing was executed', /nothing was executed/i.test(r1), r1);
check('names the tool it wanted to run', r1.includes('delete_repository'), r1);

// ── Case 2: the backup returns nothing at all ─────────────────────────────────
aiGateway.agentChat = async () => ({ text: '', toolCalls: [], provider: 'groq' });
chatService.sessions.clear();
const r2 = await chatService.processMessage('u2', 'summarize my latest commit');
check('empty fallback is reported honestly', /could not complete/i.test(r2) && !r2.includes('✅'), r2);
check('no actions were taken is stated', /no actions were taken/i.test(r2), r2);

console.log('\n--- sample response ---\n' + r1);
console.log(failures === 0 ? '\nAll honesty checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
