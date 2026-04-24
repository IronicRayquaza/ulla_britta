import { analyzeCommits } from './services/ai.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import { generateReport } from './services/report.service.mjs';
import databaseService from './services/database.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import githubService from './services/github.service.mjs';
import axios from 'axios';

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

            // 1. Existing Feature: Narration & Quota Protection
            let analysisData;
            let markdownReport;
            const existingAnalysis = await databaseService.getNarration(repository, commitSha);

            if (existingAnalysis) {
                analysisData = existingAnalysis.full_json;
                markdownReport = existingAnalysis.report_markdown;
            } else {
                analysisData = await analyzeCommits(payload.commits, repository, branch, author);
                markdownReport = generateReport(analysisData);
                await databaseService.storeNarration(repository, { ...analysisData, report_markdown: markdownReport }, installationId);
            }
            await sendEmail(markdownReport, repository);

            // 2. NEW FEATURE: Proactive Deployment (Extension)
            const client = await githubService.getClient(installationId);
            const { data: repoInfo } = await client.rest.repos.get({ owner: repository.split('/')[0], repo: repository.split('/')[1] });
            
            // If it has no homepage, it likely hasn't been deployed yet
            if (!repoInfo.homepage) {
                const deployable = await deploymentService.isDeployable(client, repoInfo.owner.login, repoInfo.name);
                if (deployable) {
                    console.log(`✨ Project ${repository} detected as deployable! Attempting auto-hosting...`);
                    
                    // Default to Vercel if token exists, fallback to GH Pages
                    let deployUrl;
                    if (process.env.VERCEL_TOKEN) {
                        deployUrl = await deploymentService.deployToVercel(repository, installationId);
                    } else {
                        deployUrl = await deploymentService.deployToGitHubPages(installationId, repository);
                    }

                    if (deployUrl) {
                        // Update the repo homepage automatically!
                        await client.rest.repos.update({
                            owner: repoInfo.owner.login,
                            repo: repoInfo.name,
                            homepage: deployUrl
                        });
                        console.log(`🌍 Deployment Successful: ${deployUrl}`);
                    }
                }
            }
        } 
        
        else if (type === 'workflow_run' || type === 'check_run') {
            // Existing Repair logic...
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
