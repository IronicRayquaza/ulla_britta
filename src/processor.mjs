import { analyzeCommits } from './services/ai.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import { generateReport } from './services/report.service.mjs';
import databaseService from './services/database.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import githubService from './services/github.service.mjs';

export async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id;
    const repository = payload.repository?.full_name;

    if (!repository || !installationId) return;

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
            } else {
                analysisData = await analyzeCommits(payload.commits, repository, branch, author);
            }

            // 2. INTERACTIVE DEPLOYMENT CHECK (No auto-deploy anymore)
            const client = await githubService.getClient(installationId);
            const { data: repoInfo } = await client.rest.repos.get({ owner: repository.split('/')[0], repo: repository.split('/')[1] });
            
            if (!repoInfo.homepage) {
                const deployable = await deploymentService.isDeployable(client, repoInfo.owner.login, repoInfo.name);
                if (deployable) {
                    console.log(`💡 Hosting Suggestion: Adding 'Deploy Now' button to report.`);
                    analysisData.deploymentSuggestion = {
                        owner: repoInfo.owner.login,
                        repo: repoInfo.name,
                        installationId: installationId,
                        provider: process.env.VERCEL_TOKEN ? 'Vercel' : 'GitHub Pages'
                    };
                }
            }

            // 3. Generate and Store Report
            markdownReport = generateReport(analysisData);
            if (!existingAnalysis) {
                await databaseService.storeNarration(repository, { ...analysisData, report_markdown: markdownReport }, installationId);
            }
            
            await sendEmail(markdownReport, repository);
            console.log(`✅ Report sent. Standing by for approval.`);
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            const isWorkflow = type === 'workflow_run';
            const data = isWorkflow ? payload.workflow_run : payload.check_run;
            if (data.status !== 'completed' || data.conclusion !== 'failure') return;
            let runId = isWorkflow ? data.id : (data.check_suite?.workflow_run_id);
            if (!runId) return;
            const branch = isWorkflow ? data.head_branch : (data.check_suite?.head_branch || 'master');
            const result = await performDiagnostics(installationId, repository, runId, isWorkflow ? null : data, branch);
            if (result && result.report_markdown) await sendEmail(result.report_markdown, repository);
        }
    } catch (error) {
        console.error(`❌ Error in processEvent:`, error.message);
        throw error;
    }
}
