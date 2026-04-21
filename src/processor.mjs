import { analyzeCommits } from './services/ai.service.mjs';
import { generatePDF } from './services/pdf.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import axios from 'axios';

export async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id;
    
    // SAFETY: Not all events have a repository (e.g. installation, organization)
    const repository = payload.repository?.full_name;
    if (!repository) {
        console.log(`ℹ️ [SKIP] Event ${type} does not have repository context.`);
        return;
    }

    console.log(`\n👨‍💻 Working on ${type} for ${repository}...`);

    try {
        if (type === 'push') {
            const analysis = await analyzeCommits(payload.commits, repository);
            const pdfPath = await generatePDF(analysis);
            await sendEmail(pdfPath, repository);
            console.log(`✅ [NARRATOR] Report sent successfully.`);
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            const isWorkflow = type === 'workflow_run';
            const data = isWorkflow ? payload.workflow_run : payload.check_run;
            
            // Only act if it's a failure
            const isFailure = data.conclusion === 'failure' || data.status === 'completed' && data.conclusion === 'failure';
            if (!isFailure) return;

            const runId = data.id;
            const branch = isWorkflow ? data.head_branch : (data.check_suite?.head_branch || 'master');

            await performDiagnostics(installationId, repository, runId, isWorkflow ? null : data, branch);
        }

        else if (type === 'pull_request') {
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
                await handleConflict(installationId, pr.number, repository, pr.head.ref, pr.base.ref);
            }
        }
    } catch (error) {
        console.error(`❌ Error processing ${type}:`, error.message);
        if (error.response?.data) {
            console.error('Error Details:', JSON.stringify(error.response.data));
        }
        throw error;
    }
}
