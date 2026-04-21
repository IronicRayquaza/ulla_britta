import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeWithGemini } from './ai.service.mjs';
import githubService from './github.service.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_PATH = path.join(__dirname, '../../registry.json');

if (!fs.existsSync(REGISTRY_PATH)) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ processedRuns: [], processedPRs: {} }));
}

function getRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function updateRegistry(key, value) {
  const registry = getRegistry();
  if (Array.isArray(registry[key])) {
    registry[key].push(value);
  } else {
    registry[key] = { ...registry[key], ...value };
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

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
        console.log(`📖 Fetching logs for run: ${runId}`);
        // Now guaranteed to have .rest.actions
        const { data: jobsData } = await client.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
        const failedJob = jobsData.jobs.find(j => j.conclusion === 'failure');
        if (!failedJob) return "No failure found in job list.";
        
        const { data: logs } = await client.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: failedJob.id });
        return logs.substring(0, 15000);
    } catch (error) {
        console.error(`❌ Log fetch error:`, error.message);
        return "";
    }
}

export async function performDiagnostics(installationId, repoFull, runId, checkRun = null, branch = 'master') {
  const [owner, repo] = repoFull.split('/');
  const client = await githubService.getClient(installationId);
  
  if (runId && getRegistry().processedRuns.includes(runId)) return null;

  try {
    console.log(`🩺 Diagnosing failure in ${repoFull}...`);
    let logData = (runId) ? await fetchFailedLogs(client, owner, repo, runId) : "External check data";
    
    if (!logData || logData.length < 50) {
        console.log("⚠️ No logs available to analyze. Surgery aborted.");
        return null;
    }

    const { data: treeData } = await client.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: true });
    const repoStructure = treeData.tree.map(i => `${i.type === 'tree' ? '[DIR]' : '[FILE]'} ${i.path}`).join('\n');
    
    console.log(`🧠 Consulting gemini-3-flash-preview for the fix...`);
    const fileAnalysisPrompt = `Build failed. LOGS:\n${logData}\n\nSTRUCTURE:\n${repoStructure}\nIdentify faulty files (comma-separated pathways only).`;
    const suspectedFilesRaw = await analyzeWithGemini(fileAnalysisPrompt);
    const suspectedFiles = suspectedFilesRaw.split(',').map(f => f.trim().replace(/['"]/g, ''));

    console.log(`📂 Inspecting files: ${suspectedFiles.join(', ')}`);
    let fileContents = "";
    for (const filePath of suspectedFiles) {
        const content = await fetchFileContent(client, owner, repo, filePath, branch);
        if (content) fileContents += `\n--- ${filePath} ---\n${content}\n`;
    }

    const prompt = `Fix build in ${repoFull} on branch ${branch}.\nLOGS:\n${logData}\nCONTEXT:\n${fileContents}\nReturn JSON: { "explanation": "...", "filesToFix": [{ "path": "...", "newContent": "..." }] }`;
    const rawFix = await analyzeWithGemini(prompt);
    const fix = JSON.parse(rawFix.replace(/```json|```/g, '').trim());
    
    console.log(`💉 Applying fix: ${fix.explanation}`);
    const success = await commitRemotely(client, owner, repo, fix, branch);
    if (success && runId) updateRegistry('processedRuns', runId);
    console.log(`🏁 Surgery complete.`);
    return fix;
  } catch (error) {
    console.error(`❌ Surgery failed:`, error.message);
    return null;
  }
}

export async function handleConflict(installationId, prNumber, repoFull, headRef, baseRef) {
  const [owner, repo] = repoFull.split('/');
  const client = await githubService.getClient(installationId);
  if (getRegistry().processedPRs[prNumber] === headRef) return null;

  try {
    const { data: files } = await client.rest.pulls.listFiles({ owner, repo, pull_number: prNumber });
    for (const file of files) {
      const baseContent = await fetchFileContent(client, owner, repo, file.filename, baseRef);
      const headContent = await fetchFileContent(client, owner, repo, file.filename, headRef);
      const prompt = `Resolve conflict in '${file.filename}'.\nBase:\n${baseContent}\n\nHead:\n${headContent}\nReturn merged content.`;
      const mergedContent = await analyzeWithGemini(prompt);
      await commitRemotely(client, owner, repo, { explanation: "Resolved conflict", filesToFix: [{ path: file.filename, newContent: mergedContent }] }, headRef);
    }
    await client.rest.pulls.merge({ owner, repo, pull_number: prNumber });
    updateRegistry('processedPRs', { [prNumber]: headRef });
    return true;
  } catch (error) {
    return false;
  }
}
