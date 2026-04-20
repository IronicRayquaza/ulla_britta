const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { analyzeWithGemini } = require('./ai.service');

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
    registry[key] = { ...registry[key], ...value };
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Fetches the content of a file from GitHub
 */
async function fetchFileContent(repoName, filePath, token, branch = 'master') {
    try {
      const url = `https://api.github.com/repos/${repoName}/contents/${filePath}?ref=${branch}`;
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return Buffer.from(response.data.content, 'base64').toString();
    } catch (error) {
      console.error(`Could not fetch content for ${filePath}:`, error.message);
      return null;
    }
}

/**
 * Fetches the SHA of a file (required for updating it via GitHub API).
 */
async function fetchFileSha(repoName, filePath, token, branch = 'master') {
  try {
    const url = `https://api.github.com/repos/${repoName}/contents/${filePath}?ref=${branch}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.sha;
  } catch (error) {
    console.error(`Could not SHA for ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Commits a fix directly to GitHub without cloning.
 */
async function commitRemotely(repoName, fix, token, branch = 'master') {
  try {
    for (const file of fix.filesToFix) {
      console.log(`Surgery in progress: Updating ${file.path} in ${repoName}...`);
      
      const sha = await fetchFileSha(repoName, file.path, token, branch);
      const url = `https://api.github.com/repos/${repoName}/contents/${file.path}`;
      
      const response = await axios.put(url, {
        message: `🤖 [AI-AUTO-FIX] ${fix.explanation}`,
        content: Buffer.from(file.newContent).toString('base64'),
        sha: sha,
        branch: branch
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      console.log(`✅ Success! Commit ${response.data.commit.sha} created.`);
    }
    return true;
  } catch (error) {
    console.error('Remote Surgery Failed:', error.response ? error.response.data : error.message);
    return false;
  }
}

/**
 * Fetches the logs of a failed workflow run.
 */
async function fetchFailedLogs(repoName, runId, token) {
  try {
    const jobsUrl = `https://api.github.com/repos/${repoName}/actions/runs/${runId}/jobs`;
    const jobsResponse = await axios.get(jobsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const failedJob = jobsResponse.data.jobs.find(j => j.conclusion === 'failure');
    if (!failedJob) return "No explicitly failed job found in logs.";

    const logsUrl = `https://api.github.com/repos/${repoName}/actions/jobs/${failedJob.id}/logs`;
    const logsResponse = await axios.get(logsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    return logsResponse.data.substring(0, 15000); 
  } catch (error) {
    console.error(`Could not fetch logs for run ${runId}:`, error.message);
    return "Log retrieval failed.";
  }
}

/**
 * Fetches the file structure (tree) of the repository as a formatted string.
 */
async function fetchRepoStructure(repoName, token, branch = 'master') {
  try {
    const url = `https://api.github.com/repos/${repoName}/git/trees/${branch}?recursive=1`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    // Group files into a tree-like list
    return response.data.tree
      .map(item => `${item.type === 'tree' ? '[DIR] ' : '[FILE]'} ${item.path}`)
      .join('\n');
  } catch (error) {
    console.warn('Could not fetch repo structure:', error.message);
    return "Could not retrieve file structure.";
  }
}

/**
 * Fetches the default branch of a repository.
 */
async function getDefaultBranch(repoName, token) {
    try {
        const response = await axios.get(`https://api.github.com/repos/${repoName}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data.default_branch;
    } catch (error) {
        return 'main'; // Fallback
    }
}

/**
 * Self-Healing logic for fixing broken builds.
 */
async function performDiagnostics(runId, repoName, checkRun = null, branch = null) {
  const token = process.env.GITHUB_TOKEN;
  
  if (runId && getRegistry().processedRuns.includes(runId)) {
    console.log(`⏭️ Run ${runId} already processed. Skipping.`);
    return null;
  }

  // Detect branch if not provided
  if (!branch) {
      branch = await getDefaultBranch(repoName, token);
  }

  try {
    let logData = "";
    if (runId) {
        logData = await fetchFailedLogs(repoName, runId, token);
    } else if (checkRun) {
        logData = `External Check: ${checkRun.name}\nSummary: ${checkRun.output?.summary}\nText: ${checkRun.output?.text}`;
    }

    // 1. GET FULL ARCHITECTURAL CONTEXT
    const repoStructure = await fetchRepoStructure(repoName, token, branch);
    
    // 2. GET MANIFEST CONTEXT (package.json, README)
    const packageJson = await fetchFileContent(repoName, 'package.json', token, branch);
    const readme = await fetchFileContent(repoName, 'README.md', token, branch);
    
    let baseContext = `PROJECT STRUCTURE:\n${repoStructure}\n`;
    if (packageJson) baseContext += `\nPACKAGE.JSON:\n${packageJson}\n`;
    if (readme) baseContext += `\nREADME.MD:\n${readme}\n`;

    // 3. TARGETED FILE DISCOVERY
    const fileAnalysisPrompt = `You are a Senior DevOps Engineer. A build failed.\n\n${baseContext}\n\nERROR LOGS:\n${logData}\n\nBased on this, which 2-3 files are most likely causing the issue? Return only the file paths, comma-separated.`;
    const suspectedFilesRaw = await analyzeWithGemini(fileAnalysisPrompt);
    const suspectedFiles = suspectedFilesRaw.split(',').map(f => f.trim().replace(/^'|'$/g, '').replace(/^"|"$/g, ''));

    // 4. READ SUSPECTED FILES
    let fileContents = "";
    for (const filePath of suspectedFiles) {
        if (!filePath) continue;
        const content = await fetchFileContent(repoName, filePath, token, branch);
        if (content) {
            fileContents += `\n--- CONTENT OF ${filePath} ---\n${content}\n`;
        }
    }

    // 5. GENERATE FINAL FIX
    const prompt = `
The build failed in ${repoName} on branch ${branch}.

${baseContext}
${fileContents}

ERROR LOGS:
${logData}

TASK: Provide a fix. Return a JSON object with 'explanation' and 'filesToFix' (an array of {path, newContent} objects).
`;

    const rawFix = await analyzeWithGemini(prompt);
    const jsonString = rawFix.replace(/```json|```/g, '').trim();
    const fix = JSON.parse(jsonString);
    
    const success = await commitRemotely(repoName, fix, token, branch);
    
    if (success && runId) {
        updateRegistry('processedRuns', runId);
    }

    return success ? fix : null;

  } catch (error) {
    console.error('Healing process failed:', error);
    return null;
  }
}

/**
 * Handles merge conflicts by suggesting a resolution.
 */
async function handleConflict(prNumber, repoName, headRef, baseRef) {
  const token = process.env.GITHUB_TOKEN;
  const headers = { Authorization: `token ${token}` };
  
  // Prevent duplicate work
  const registry = getRegistry();
  if (registry.processedPRs[prNumber] === headRef) {
    console.log(`⏭️ Conflict for PR #${prNumber} at ${headRef} already resolved. Skipping.`);
    return null;
  }

  try {
    console.log(`Resolving conflict for PR #${prNumber} in ${repoName}...`);
    
    const { data: files } = await axios.get(
      `https://api.github.com/repos/${repoName}/pulls/${prNumber}/files`,
      { headers }
    );

    for (const file of files) {
      if (file.status === 'modified' || file.status === 'changed') {
        const [baseFile, headFile] = await Promise.all([
          axios.get(`https://api.github.com/repos/${repoName}/contents/${file.filename}?ref=${baseRef}`, { headers }),
          axios.get(`https://api.github.com/repos/${repoName}/contents/${file.filename}?ref=${headRef}`, { headers })
        ]);

        const baseContent = Buffer.from(baseFile.data.content, 'base64').toString();
        const headContent = Buffer.from(headFile.data.content, 'base64').toString();

        const prompt = `Merge conflict in '${file.filename}'.
Base:
${baseContent}

Head:
${headContent}

Return ONLY the merged file content.`;

        const mergedContent = await analyzeWithGemini(prompt);

        await axios.put(
          `https://api.github.com/repos/${repoName}/contents/${file.filename}`,
          {
            message: `🤖 [AI-AUTO-FIX] Resolved merge conflict in ${file.filename}`,
            content: Buffer.from(mergedContent).toString('base64'),
            sha: headFile.data.sha,
            branch: headRef
          },
          { headers }
        );
      }
    }

    // Attempt merge
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      await axios.put(`https://api.github.com/repos/${repoName}/pulls/${prNumber}/merge`, {
        commit_title: `🤖 [AI-AUTO-MERGE] Resolved and merged PR #${prNumber}`,
        merge_method: 'merge'
      }, { headers });
      
      updateRegistry('processedPRs', { [prNumber]: headRef });
      console.log(`🏁 PR #${prNumber} merged.`);
    } catch (e) {
        console.error("Auto-merge failed.");
    }

    return true;
  } catch (error) {
    console.error('Conflict resolution failed:', error.message);
    return false;
  }
}

module.exports = { performDiagnostics, handleConflict };
