const { analyzeCommits } = require('./services/ai.service');
const { generatePDF } = require('./services/pdf.service');
const { sendEmail } = require('./services/email.service');
const { performDiagnostics, handleConflict } = require('./services/healing.service');
const axios = require('axios');

async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id; // Needed for GitHub App
    const repository = payload.repository.full_name;

    console.log(`Working on ${type} for ${repository}...`);

    try {
        if (type === 'push') {
            const analysis = await analyzeCommits(payload.commits, repository);
            const pdfPath = await generatePDF(analysis);
            await sendEmail(pdfPath, repository);
            console.log(`✅ [NARRATOR] Report sent.`);
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            const isWorkflow = type === 'workflow_run';
            const data = isWorkflow ? payload.workflow_run : payload.check_run;
            const runId = data.id;
            const branch = isWorkflow ? data.head_branch : (data.check_suite?.head_branch || 'master');

            await performDiagnostics(installationId, repository, runId, isWorkflow ? null : data, branch);
        }

        else if (type === 'pull_request') {
            if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
            
            let pr = payload.pull_request;
            // Wait for mergeable
            for (let i = 0; i < 5; i++) {
                if (pr.mergeable !== null && pr.mergeable !== undefined) break;
                await new Promise(r => setTimeout(r, 4000));
                const { data } = await axios.get(pr.url, {
                    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
                });
                pr = data;
            }

            if (pr.mergeable === false) {
                await handleConflict(installationId, pr.number, repository, pr.head.ref, pr.base.ref);
            }
        }
    } catch (error) {
        console.error(`Error processing ${type}:`, error.message);
    }
}

module.exports = { processEvent };
