const queueService = require('./queue');
const { processEvent } = require('./processor');
const dotenv = require('dotenv');

dotenv.config();

console.log('🤖 Ulla Britta Worker is standing by...');

async function startWorker() {
    while (true) {
        try {
            const event = await queueService.dequeue();
            if (event) {
                console.log(`\n🧵 Processing task: ${event.type} (${event.id})`);
                await processEvent(event);
                console.log(`🏁 Task complete: ${event.id}`);
            }
        } catch (error) {
            console.error('❌ Worker error:', error.message);
            // Politeness delay on error
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

startWorker();
