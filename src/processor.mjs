import { analyzeCommits } from './services/ai.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import { generateReport } from './services/report.service.mjs';
import databaseService from './services/database.service.mjs';
import axios from 'axios';

export async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id;
    const repository = payload.repository?.full_name;

    if (!repository || !installationId) {
        return;
    }

    try {
        if (type === 'push') {
            console.log(`\n👨‍💻 Analyzing push for ${repository}...`);
            const author = payload.pusher?.name || 'Unknown';
            const branch = payload.ref?.replace('refs/heads/', '') || 'main';
            const commitSha = payload.commits[0]?.id;

            // 1. Quota Check (Cache)
            const existingAnalysis = await databaseService.getNarration(repository, commitSha);
            let analysisData;
            let markdownReport;

            if (existingAnalysis) {
                console.log(`♻️  Using cached analysis for ${repository}`);
                analysisData = existingAnalysis.full_json;
                markdownReport = existingAnalysis.report_markdown;
            } else {
                // 2. Fresh AI Analysis
                analysisData = await analyzeCommits(payload.commits, repository, branch, author);
                markdownReport = generateReport(analysisData);
                
                // 3. Store in DB with Installation ID
                await databaseService.storeNarration(repository, {
                    ...analysisData,
                    report_markdown: markdownReport
                }, installationId);
            }
            
            await sendEmail(markdownReport, repository);
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            const isWorkflow = type === 'workflow_run';
            const data = isWorkflow ? payload.workflow_run : payload.check_run;
            
            if (data.status !== 'completed' || data.conclusion !== 'failure') return;

            console.log(`🚨 Failure detected in ${repository}! Starting autonomous repair...`);
            
            let runId = isWorkflow ? data.id : (data.check_suite?.workflow_run_id);
            if (!runId) return;

            const branch = isWorkflow ? data.head_branch : (data.check_suite?.head_branch || 'master');
            
            // Repair logic (passes installationId internally to storeFix)
            const result = await performDiagnostics(installationId, repository, runId, isWorkflow ? null : data, branch);
            
            if (result && result.report_markdown) {
                await sendEmail(result.report_markdown, repository);
            }
        }

        else if (type === 'pull_request') {
            if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
            
            let pr = payload.pull_request;
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
