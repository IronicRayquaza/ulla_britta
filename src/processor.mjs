import { analyzeCommits } from './services/ai.service.mjs';
import { sendEmail } from './services/email.service.mjs';
import { performDiagnostics, handleConflict } from './services/healing.service.mjs';
import { generateReport } from './services/report.service.mjs';
import databaseService from './services/database.service.mjs';
import deploymentService from './services/deployment.service.mjs';
import githubService from './services/github.service.mjs';
import logger from './services/logger.service.mjs';
import vercelService from './services/vercel.service.mjs';
import repoAnalyzer from './services/repo-analyzer.service.mjs';
import codeGenerator from './services/code-generator.service.mjs';
import path from 'path';

export async function processEvent(event) {
    const { type, payload } = event;
    const installationId = payload.installation?.id || payload.installationId || (payload.installation && typeof payload.installation === 'number' ? payload.installation : null);
    const repository = payload.repository?.full_name || payload.repository;

    if (!repository || !installationId) {
        console.log(`⚠️  Skipping task ${type} (${event.id}): Missing repository (${repository}) or installationId (${installationId})`);
        return;
    }

    try {
        // 1. Context Resolution (Who is this for?)
        const owner = repository.split('/')[0];
        let userId = await databaseService.getUserIdByGithubUsername(owner);
        
        if (!userId) {
            userId = '00000000-0000-0000-0000-000000000000'; // Global System ID fallback
            await logger.warn(`Identity Fallback: No profile for ${owner}. Running in anonymous mode.`);
        }

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
        } else if (type === 'vercel_failure') {
            await logger.warn(`🔥 Vercel Build Failure detected for ${payload.project_name}! Fetching logs...`);
            
            const logs = await vercelService.getDeploymentLogs(payload.deployment_id);
            const branch = payload.branch || 'main';

            // Gather context from GitHub (package.json and next.config.js are key for Vercel)
            const client = await githubService.getClient(installationId);
            const getFile = async (path) => {
                try {
                    const { data } = await client.rest.repos.getContent({ owner, repo: repository.split('/')[1], path, ref: branch });
                    return Buffer.from(data.content, 'base64').toString();
                } catch (e) { return null; }
            };

            const packageJson = await getFile('package.json');
            const nextConfig = await getFile('next.config.js');
            const context = `[FILES]\npackage.json: ${packageJson}\nnext.config.js: ${nextConfig}`;

            // We reuse the healing service logic but with Vercel logs as input
            const result = await performDiagnostics(installationId, repository, null, null, branch, logs, context);

            if (result && result.report_markdown) {
                await sendEmail(result.report_markdown, repository);
                await logger.success(`Vercel auto-fix applied! Triggering redeploy...`);
                await vercelService.triggerRedeploy(payload.deployment_id);
            }
        }

        else if (type === 'feature_request') {
            await logger.info(`🏗️  Feature Request Received for #${payload.issue_number}. Starting construction...`);
            
            const client = await githubService.getClient(installationId);
            
            // Fetch installation token to support PRIVATE repos
            const { data: tokenData } = await client.rest.apps.createInstallationAccessToken({ installation_id: installationId });
            const repoPath = await repoAnalyzer.cloneRepo(payload.owner, payload.repo, payload.branch, tokenData.token);
            
            if (!repoPath) throw new Error('Could not clone repository for analysis.');

            const stack = await repoAnalyzer.detectTechStack(repoPath);
            const structure = await repoAnalyzer.getStructure(repoPath);

            await logger.info(`📊 Repository analyzed. Generating implementation plan...`);
            const plan = await codeGenerator.generatePlan(payload, stack, structure);

            if (plan.confidence < 70) {
                await githubService.addComment(client, payload.owner, payload.repo, payload.issue_number, 
                    `🤖 **Ulla Britta here!** I've analyzed this request but my confidence (${plan.confidence}%) is below the automation threshold. I'll leave this for human review.`);
                await logger.warn(`Confidence too low (${plan.confidence}%). Aborting auto-build.`);
                return;
            }

            const branchName = `ulla/feature-${payload.issue_number}`;
            await githubService.createBranch(client, payload.owner, payload.repo, branchName, payload.branch);

            // 1. Create New Files
            for (const f of plan.filesToCreate) {
                const code = await codeGenerator.generateFile(f, stack, structure);
                await githubService.createOrUpdateFile(client, payload.owner, payload.repo, f.path, `[ULLA] Create ${f.path}`, code, branchName);
            }

            // 2. Modify Existing Files
            for (const f of plan.filesToModify) {
                const original = await repoAnalyzer.getFileContent(path.join(repoPath, f.path)).catch(() => "");
                const modified = await codeGenerator.generateFile(f, stack, original);
                await githubService.createOrUpdateFile(client, payload.owner, payload.repo, f.path, `[ULLA] Update ${f.path}`, modified, branchName);
            }

            const pr = await githubService.createPullRequest(client, payload.owner, payload.repo, {
                title: `🤖 Ulla Build: ${payload.issue_title}`,
                body: `## Autonomous Implementation by Ulla Britta\n\nCloses #${payload.issue_number}\n\n**Approach:** ${plan.approach}\n\n**Confidence:** ${plan.confidence}%`,
                head: branchName,
                base: payload.branch
            });

            await githubService.addComment(client, payload.owner, payload.repo, payload.issue_number, `✅ I've built this feature! See Pull Request #${pr.number} 🚀`);
            await logger.success(`Feature Build Complete! Opened PR #${pr.number}`);
            
            await repoAnalyzer.cleanup(repoPath);
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
