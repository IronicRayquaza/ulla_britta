import { analyzeCommits } from './services/ai.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import { generateReport } from './services/report.service.mjs';
import databaseService from './services/database.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import githubService from './services/github.service.mjs';
import logger from './services/logger.service.mjs';

export async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id;
    const repository = payload.repository?.full_name;

    if (!repository || !installationId) return;

    try {
        // 1. Context Resolution (Who is this for?)
        const owner = repository.split('/')[0];
        const userId = await databaseService.getUserIdByGithubUsername(owner);
        
        logger.setContext(userId, repository, 'worker');
        await logger.info(`Received ${type} event. Preparing brain...`);

        if (type === 'push') {
            const author = payload.pusher?.name || 'Unknown';
            const branch = payload.ref?.replace('refs/heads/', '') || 'main';
            const commitSha = payload.commits[0]?.id;

            await logger.info(`Processing push from ${author} on branch ${branch}...`);

            // 2. Quota Check (Cache)
            const existingAnalysis = await databaseService.getNarration(repository, commitSha);
            let analysisData;

            if (existingAnalysis) {
                await logger.info(`♻️  Using cached analysis for this commit.`);
                analysisData = existingAnalysis.full_json;
            } else {
                await logger.info(`🧠 Analyzing commits with Gemini AI...`);
                analysisData = await analyzeCommits(payload.commits, repository, branch, author);
                await logger.success(`Analysis complete!`);
            }

            // 3. DIAGNOSTIC DEPLOYMENT CHECK
            const client = await githubService.getClient(installationId);
            const { data: repoInfo } = await client.rest.repos.get({ owner: repository.split('/')[0], repo: repository.split('/')[1] });
            
            if (!repoInfo.homepage) {
                const deployable = await deploymentService.isDeployable(client, repoInfo.owner.login, repoInfo.name);
                if (deployable) {
                    await logger.info(`🚀 Hosting Opportunity Detected! Suggesting deployment in report.`);
                    analysisData.deploymentSuggestion = {
                        owner: repoInfo.owner.login,
                        repo: repoInfo.name,
                        installationId: installationId,
                        provider: process.env.VERCEL_TOKEN ? 'Vercel' : 'GitHub Pages'
                    };
                }
            }

            // 4. Generate and Store Report
            const markdownReport = generateReport(analysisData);
            if (!existingAnalysis) {
                await databaseService.storeNarration(repository, { ...analysisData, report_markdown: markdownReport }, installationId);
            }
            
            await sendEmail(markdownReport, repository);
            await logger.success(`Final report sent via email. 🏁`);
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            const isWorkflow = type === 'workflow_run';
            const data = isWorkflow ? payload.workflow_run : payload.check_run;
            if (data.status !== 'completed' || data.conclusion !== 'failure') return;
            
            await logger.warn(`🔥 CI/CD Failure detected! Initiating surgical diagnostics...`);
            
            let runId = isWorkflow ? data.id : (data.check_suite?.workflow_run_id);
            if (!runId) return;
            const branch = isWorkflow ? data.head_branch : (data.check_suite?.head_branch || 'master');
            
            const result = await performDiagnostics(installationId, repository, runId, isWorkflow ? null : data, branch);
            
            if (result && result.report_markdown) {
                await sendEmail(result.report_markdown, repository);
                await logger.success(`Auto-fix applied and surgical report sent. 🩹`);
            }
        }
    } catch (error) {
        await logger.error(`❌ Agent Error: ${error.message}`);
        throw error;
    }
}
