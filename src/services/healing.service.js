const fs = require('fs');
const path = require('path');
const { analyzeWithGemini } = require('./ai.service');
const githubService = require('./github.service');

const REGISTRY_PATH = path.join(__dirname, '../../registry.json');

// Initialize registry if it doesn't exist
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
    // If it's an object (like processedPRs), merge it
    registry[key] = { ...registry[key], ...value };
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Fetches file content using Octokit
 */
async function fetchFileContent(client, owner, repo, filePath, branch) {
    try {
      const { data } = await client.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch
      });
      return Buffer.from(data.content, 'base64').toString();
    } catch (error) {
      console.error(`Could not fetch content for ${filePath}:`, error.message);
      return null;
    }
}

/**
 * Commits a fix directly to GitHub
 */
async function commitRemotely(client, owner, repo, fix, branch) {
  try {
    for (const file of fix.filesToFix) {
      console.log(`Surgery in progress: Updating ${file.path} in ${owner}/${repo}...`);
      
      // Get current SHA
      let sha;
      try {
          const { data } = await client.rest.repos.getContent({ owner, repo, path: file.path, ref: branch });
          sha = data.sha;
      } catch (e) {
          sha = null; // New file
      }
      
      await client.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: file.path,
        message: `🤖 [AI-AUTO-FIX] ${fix.explanation}`,
        content: Buffer.from(file.newContent).toString('base64'),
        sha,
        branch
      });

      console.log(`✅ Success! Updated ${file.path}`);
    }
    return true;
  } catch (error) {
    console.error('Remote Surgery Failed:', error.message);
    return false;
  }
}

/**
 * Fetches logs for a failed run
 */
async function fetchFailedLogs(client, owner, repo, runId) {
    try {
        const { data: jobsData } = await client.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
        const failedJob = jobsData.jobs.find(j => j.conclusion === 'failure');
        if (!failedJob) return "No explicitly failed job found.";

        const { data: logs } = await client.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: failedJob.id });
        return logs.substring(0, 15000);
    } catch (error) {
        console.error(`Log fetch error: ${error.message}`);
        return "Log retrieval failed.";
    }
}

/**
 * Main "Surgeon" logic
 */
async function performDiagnostics(installationId, repoFull, runId, checkRun = null, branch = 'master') {
  const [owner, repo] = repoFull.split('/');
  const client = await githubService.getClient(installationId);
  
  if (runId && getRegistry().processedRuns.includes(runId)) {
    console.log(`⏭️ Run ${runId} already processed.`);
    return null;
  }

  try {
    let logData = "";
    if (runId) {
        logData = await fetchFailedLogs(client, owner, repo, runId);
    } else if (checkRun) {
        logData = `External Check: ${checkRun.name}\nSummary: ${checkRun.output?.summary}`;
    }

    // 1. Structure
    const { data: treeData } = await client.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: true });
    const repoStructure = treeData.tree.map(i => `${i.type === 'tree' ? '[DIR]' : '[FILE]'} ${i.path}`).join('\n');
    
    // 2. Manifests
    const packageJson = await fetchFileContent(client, owner, repo, 'package.json', branch);
    const readme = await fetchFileContent(client, owner, repo, 'README.md', branch);
    
    let baseContext = `PROJECT STRUCTURE:\n${repoStructure}\n`;
    if (packageJson) baseContext += `\nPACKAGE.JSON:\n${packageJson}\n`;

    // 3. AI File Discovery
    const fileAnalysisPrompt = `Build failed. LOGS:\n${logData}\n\nSTRUCTURE:\n${repoStructure}\nIdentify 2-3 files at fault. Return comma-separated paths only.`;
    const suspectedFilesRaw = await analyzeWithGemini(fileAnalysisPrompt);
    const suspectedFiles = suspectedFilesRaw.split(',').map(f => f.trim().replace(/['"]/g, ''));

    // 4. Ingest Files
    let fileContents = "";
    for (const filePath of suspectedFiles) {
        const content = await fetchFileContent(client, owner, repo, filePath, branch);
        if (content) fileContents += `\n--- ${filePath} ---\n${content}\n`;
    }

    // 5. Generate and Apply Fix
    const prompt = `Fix build failure in ${repoFull} on branch ${branch}.\nCONTEXT:\n${baseContext}\n${fileContents}\nLOGS:\n${logData}\nReturn JSON: { "explanation": "...", "filesToFix": [{ "path": "...", "newContent": "..." }] }`;

    const rawFix = await analyzeWithGemini(prompt);
    const fix = JSON.parse(rawFix.replace(/```json|```/g, '').trim());
    
    const success = await commitRemotely(client, owner, repo, fix, branch);
    if (success && runId) updateRegistry('processedRuns', runId);
    return success ? fix : null;

  } catch (error) {
    console.error('Surgery failed:', error.message);
    return null;
  }
}

/**
 * Main "Mediator" logic
 */
async function handleConflict(installationId, prNumber, repoFull, headRef, baseRef) {
  const [owner, repo] = repoFull.split('/');
  const client = await githubService.getClient(installationId);
  
  const registry = getRegistry();
  if (registry.processedPRs[prNumber] === headRef) return null;

  try {
    const { data: files } = await client.rest.pulls.listFiles({ owner, repo, pull_number: prNumber });

    for (const file of files) {
      if (file.status === 'modified' || file.status === 'changed') {
        const baseContent = await fetchFileContent(client, owner, repo, file.filename, baseRef);
        const headContent = await fetchFileContent(client, owner, repo, file.filename, headRef);

        const prompt = `Merge conflict in '${file.filename}'.\nBase (${baseRef}):\n${baseContent}\n\nHead (${headRef}):\n${headContent}\nReturn ONLY merged content.`;
        const mergedContent = await analyzeWithGemini(prompt);

        await commitRemotely(client, owner, repo, {
            explanation: `Resolved conflict in ${file.filename}`,
            filesToFix: [{ path: file.filename, newContent: mergedContent }]
        }, headRef);
      }
    }

    // Auto-Merge
    await new Promise(r => setTimeout(r, 5000));
    try {
      await client.rest.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: 'merge' });
      updateRegistry('processedPRs', { [prNumber]: headRef });
      console.log(`🏁 PR #${prNumber} merged.`);
    } catch (e) {
      console.warn("Auto-merge pending or failed.");
    }

    return true;
  } catch (error) {
    console.error('Mediator failed:', error.message);
    return false;
  }
}

module.exports = { performDiagnostics, handleConflict };
