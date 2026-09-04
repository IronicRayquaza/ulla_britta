import chatService from '../../src/services/chat.service.mjs';
import databaseService from '../../src/services/database.service.mjs';
import logger from '../../src/services/logger.service.mjs';

// Keep the suite offline: the gate must be provable without touching GitHub or Supabase.
databaseService.getInstallationIdByRepo = async () => null;
logger.log = async () => {};

const USER = 'test-user-1';
const ARGS = { repoName: 'someone/important-repo' };
let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failures++;
};

// Simulate the user sending their first message.
chatService.turnCounter.set(USER, 1);

// 1. First call to a destructive tool must be blocked.
const r1 = await chatService.executeTool(USER, 'delete_repository', ARGS);
check('first delete_repository call is blocked', r1.startsWith('CONFIRMATION_REQUIRED'));
check('blocked response names the target', r1.includes('important-repo'));

// 2. Calling again in the SAME turn must still be blocked — the agent must not be
//    able to raise and satisfy its own confirmation inside one loop.
const r2 = await chatService.executeTool(USER, 'delete_repository', ARGS);
check('second call in the same turn is still blocked', r2.startsWith('CONFIRMATION_REQUIRED'));

// 3. After the user sends another message (turn advances), the confirmation is valid.
chatService.turnCounter.set(USER, 2);
const r3 = await chatService.executeTool(USER, 'delete_repository', ARGS);
check('after a new user turn the gate opens', !r3.startsWith('CONFIRMATION_REQUIRED'));

// 4. The confirmation is single-use — a repeat must be blocked again.
chatService.turnCounter.set(USER, 3);
const r4 = await chatService.executeTool(USER, 'delete_repository', ARGS);
check('confirmation is single-use', r4.startsWith('CONFIRMATION_REQUIRED'));

// 5. A confirmation for one repo must not authorise a different repo.
chatService.turnCounter.set(USER, 4);
const r5 = await chatService.executeTool(USER, 'delete_repository', { repoName: 'someone/other-repo' });
check('confirmation does not transfer to a different target', r5.startsWith('CONFIRMATION_REQUIRED'));

// 6. Non-destructive tools are unaffected.
check('non-destructive tools are not gated',
  !(await chatService.executeTool(USER, 'list_user_repositories', {})).startsWith('CONFIRMATION_REQUIRED'));

console.log(failures === 0 ? '\nAll gate checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
