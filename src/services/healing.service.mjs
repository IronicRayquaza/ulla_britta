import { analyzeWithGemini } from './ai.service.mjs';
import githubService from './github.service.mjs';
import databaseService from './database.service.mjs';
import { generateReport } from './report.service.mjs';

async function fetchFileContent(client, owner, repo, filePath, branch) {
    try {
      const { data } = await client.rest.repos.getContent({ owner, repo, path: filePath, ref: branch });
      return Buffer.from(data.content, 'base64').toString();
    } catch (error) {
      return null;
    }
}

async function commitRemotely(client, owner, repo, fix, branch) {
  try {
    for (const file of fix.filesToFix) {
      let sha;
      try {
          const { data } = await client.rest.repos.getContent({ owner, repo, path: file.path, ref: branch });
          sha = data.sha;
      } catch (e) { sha = null; }
      
      await client.rest.repos.createOrUpdateFileContents({
        owner, repo, path: file.path,
        message: `🤖 [AI-AUTO-FIX] ${fix.explanation}`,
        content: Buffer.from(file.newContent).toString('base64'),
        sha, branch
      });
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function fetchFailedLogs(client, owner, repo, runId) {
    await new Promise(r => setTimeout(r, 6000));
    try {
        const actions = client.actions || client.rest?.actions;
        const { data: jobsData } = await actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
        const failedJob = jobsData.jobs.find(j => j.conclusion === 'failure');
        if (!failedJob) return "";
        const { data: logs } = await actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: failedJob.id });
        return logs.substring(0, 15000);
    } catch (error) {
        return "";
    }
}

export async function performDiagnostics(installationId, repoFull, runId, checkRun = null, branch = 'master', manualLog = null, extraContext = null) {
  const [owner, repo] = repoFull.split('/');
  const client = await githubService.getClient(installationId);
  
  if (runId && await databaseService.isRunProcessed(runId)) return null;

  try {
    let logData = manualLog || ((runId) ? await fetchFailedLogs(client, owner, repo, runId) : "External check data");
    if (!logData || logData.length < 50) return null;

    const { data: treeData } = await client.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: true });
    const repoStructure = treeData.tree.map(i => `${i.type === 'tree' ? '[DIR]' : '[FILE]'} ${i.path}`).join('\n');
    
    let fileAnalysisPrompt = `Build failed. LOGS:\n${logData}\n\nSTRUCTURE:\n${repoStructure}\nIdentify faulty files (comma-separated pathways only).`;
    if (extraContext) fileAnalysisPrompt += `\n\nEXTRA CONTEXT:\n${extraContext}`;
    const suspectedFilesRaw = await analyzeWithGemini(fileAnalysisPrompt);
    const suspectedFiles = suspectedFilesRaw.split(',').map(f => f.trim().replace(/['"]/g, ''));

    let fileContents = "";
    for (const filePath of suspectedFiles) {
        const content = await fetchFileContent(client, owner, repo, filePath, branch);
        if (content) fileContents += `\n--- ${filePath} ---\n${content}\n`;
    }

    const prompt = `Fix build in ${repoFull} on branch ${branch}.\nLOGS:\n${logData}\nCONTEXT:\n${fileContents}\nReturn JSON matching schema: { "explanation": "string", "filesToFix": [{ "path": "string", "newContent": "string" }], "analysisData": { ...AnalysisDataSchema } }`;
    const rawFix = await analyzeWithGemini(prompt);
    const result = JSON.parse(rawFix.replace(/```json|```/g, '').trim());
    
    const success = await commitRemotely(client, owner, repo, result, branch);
    
    if (success) {
        const analysisData = {
            ...result.analysisData,
            owner, repo, branch,
            timestamp: new Date().toISOString(),
            autoFixApplied: true,
            githubUrl: `https://github.com/${repoFull}/actions/runs/${runId}`
        };
        const markdown = generateReport(analysisData);
        if (runId) await databaseService.markRunProcessed(runId, repoFull);
        
        // PASS INSTALLATION ID TO DB
        await databaseService.storeFix(repoFull, branch, { ...result, report_markdown: markdown }, installationId);
        
        return { ...result, report_markdown: markdown };
    }
  } catch (error) {
    console.error(`❌ Surgery failed:`, error.message);
  }
  return null;
}

export async function handleConflict(installationId, prNumber, repoFull, headRef, baseRef) {
  // Conflict logic...
  return false;
}
