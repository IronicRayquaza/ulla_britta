import { analyzeCommits } from './services/ai.service.mjs';
import { generatePDF } from './services/pdf.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import axios from 'axios';

export async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id;
    const repository = payload.repository?.full_name;

    if (!repository) {
        return;
    }

    try {
        if (type === 'push') {
            console.log(`\n👨‍💻 Processing push for ${repository}...`);
            const analysis = await analyzeCommits(payload.commits, repository);
            const pdfPath = await generatePDF(analysis);
            await sendEmail(pdfPath, repository);
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            const isWorkflow = type === 'workflow_run';
            const data = isWorkflow ? payload.workflow_run : payload.check_run;
            
            const status = data.status;
            const conclusion = data.conclusion;

            console.log(`\n⚙️  Event [${type}] for ${repository} | Status: ${status} | Conclusion: ${conclusion}`);

            // We ONLY act if it is COMPLETED and FAILED
            const isFinished = status === 'completed';
            const isFailure = conclusion === 'failure';

            if (!isFinished) {
                console.log(`⏳ Skipping: Run is still ${status}.`);
                return;
            }

            if (!isFailure) {
                console.log(`✅ Skipping: Run succeeded (Conclusion: ${conclusion}).`);
                return;
            }

            console.log(`🚨 Failure detected! Starting autonomous repair...`);
            
            // MAP to the correct Workflow Run ID
            let runId = isWorkflow ? data.id : null;
            
            // If it's a check_run, we need to find the associated workflow run
            if (type === 'check_run' && data.check_suite?.workflow_run_id) {
                runId = data.check_suite.workflow_run_id;
            }

            if (!runId) {
                console.log(`⚠️  Could not resolve a Workflow Run ID for this ${type}. Skipping log fetch.`);
                return;
            }

            const branch = isWorkflow ? data.head_branch : (data.check_suite?.head_branch || 'master');
            await performDiagnostics(installationId, repository, runId, isWorkflow ? null : data, branch);
        }

        else if (type === 'pull_request') {
            console.log(`\n⚖️  Processing PR #${payload.pull_request.number} for ${repository}...`);
            if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
            
            let pr = payload.pull_request;
            for (let i = 0; i < 5; i++) {
                if (pr.mergeable !== null && pr.mergeable !== undefined) break;
                await new Promise(r => setTimeout(r, 4000));
                const { data } = await axios.get(pr.url, {
                    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
                });
                pr = data;
            }

            if (pr.mergeable === false) {
                console.log(`⚔️  Conflict detected in PR #${pr.number}. Starting mediation...`);
                await handleConflict(installationId, pr.number, repository, pr.head.ref, pr.base.ref);
            }
        }
    } catch (error) {
        console.error(`❌ Error in ${type}:`, error.message);
        throw error;
    }
}
