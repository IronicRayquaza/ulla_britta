const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { analyzeWithGemini } = require('./ai.service');

/**
 * Fetches the SHA of a file (required for updating it via GitHub API).
 */
async function fetchFileSha(repoName, filePath, token) {
  try {
    const url = `https://api.github.com/repos/${repoName}/contents/${filePath}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.data.sha;
  } catch (error) {
    console.error(`Could not fetch SHA for ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Commits a fix directly to GitHub without cloning.
 */
async function commitRemotely(repoName, fix, token) {
  try {
    for (const file of fix.filesToFix) {
      console.log(`Surgery in progress: Updating ${file.path} in ${repoName}...`);
      
      const sha = await fetchFileSha(repoName, file.path, token);
      const url = `https://api.github.com/repos/${repoName}/contents/${file.path}`;
      
      const response = await axios.put(url, {
        message: `🤖 [AI-AUTO-FIX] ${fix.explanation}`,
        content: Buffer.from(file.newContent).toString('base64'),
        sha: sha
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
    // 1. Get the list of jobs for this run
    const jobsUrl = `https://api.github.com/repos/${repoName}/actions/runs/${runId}/jobs`;
    const jobsResponse = await axios.get(jobsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const failedJob = jobsResponse.data.jobs.find(j => j.conclusion === 'failure');
    if (!failedJob) return "No explicitly failed job found in logs.";

    // 2. Fetch the raw logs for the failed job
    const logsUrl = `https://api.github.com/repos/${repoName}/actions/jobs/${failedJob.id}/logs`;
    const logsResponse = await axios.get(logsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Github returns plain text for logs
    return logsResponse.data.substring(0, 10000); // Sample the first 10k characters
  } catch (error) {
    console.error(`Could not fetch logs for run ${runId}:`, error.message);
    return "Log retrieval failed. Please check token permissions for 'actions:read'.";
  }
}

/**
 * Fetches the file structure (tree) of the repository.
 */
async function fetchRepoStructure(repoName, token) {
  try {
    const url = `https://api.github.com/repos/${repoName}/git/trees/main?recursive=1`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    // Return a simplified list of files
    return response.data.tree
      .filter(item => item.type === 'blob')
      .map(item => item.path)
      .join('\n');
  } catch (error) {
    console.warn('Could not fetch repo structure:', error.message);
    return "Could not retrieve file structure.";
  }
}

/**
 * Self-Healing logic for fixing broken builds.
 */
async function performDiagnostics(runId, repoName, checkRun = null) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN is missing. Please add it to .env for Remote Surgery.');
    return null;
  }

  try {
    // 1. Fetch REAL Logs and Repo Structure
    console.log(`Analyzing ${repoName} (Run: ${runId || checkRun?.name})...`);
    
    let logData = "";
    if (runId) {
        logData = await fetchFailedLogs(repoName, runId, token);
    } else if (checkRun) {
        // Use the check run's output/summary since we might not have raw logs
        logData = `External Check: ${checkRun.name}\nSummary: ${checkRun.output?.summary || 'No summary'}\nText: ${checkRun.output?.text || 'No logs available'}`;
    }

    const repoStructure = await fetchRepoStructure(repoName, token);

    // 2. Propose Fix
    const prompt = `
The GitHub Action workflow for ${repoName} just failed. 

REPOSITORY STRUCTURE:
${repoStructure}

FAILURE LOGS:
${logData}

YOUR MISSION:
As an autonomous AI Engineer, diagnose the failure and provide a fix. 
You have FULL AUTHORITY to modify any file in the repository to resolve the issue.

GUIDANCE:
- Use the REPOSITORY STRUCTURE to determine the correct paths for files (e.g., check if it is /src/index.js or /index.js).
- If the error is in the code, provide the fixed code.
- If the error is in the workflow configuration, provide the fixed YAML.
- Search for the most likely cause of the error based on the Provided Logs.

Return the fix in exactly this JSON format (no other text):
{
  "explanation": "Detailed explanation of what failed and why this fix resolves it.",
  "filesToFix": [
    {
      "path": "path/to/file/relative/to/repo/root",
      "newContent": "REPLACE_ENTIRE_FILE_CONTENT_WITH_FIX"
    }
  ]
}
`;

    const rawFix = await analyzeWithGemini(prompt);
    // Cleanup potential markdown backticks from AI response
    const jsonString = rawFix.replace(/```json|```/g, '').trim();
    let fix;
    try {
        fix = JSON.parse(jsonString);
    } catch (e) {
        console.error("Failed to parse AI response as JSON:", jsonString);
        return null;
    }
    
    // 3. Perform Remote Surgery
    const success = await commitRemotely(repoName, fix, token);
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
  
  try {
    console.log(`Resolving conflict for PR #${prNumber} in ${repoName}...`);
    
    // 1. Get the list of files in the PR
    const { data: files } = await axios.get(
      `https://api.github.com/repos/${repoName}/pulls/${prNumber}/files`,
      { headers }
    );

    for (const file of files) {
      // In a real scenario, we check if the file is actually in conflict.
      // For this test, we'll assume the files changed in the PR are the ones to check.
      if (file.status === 'modified' || file.status === 'changed') {
        // 2. Fetch content from both branches
        const [baseFile, headFile] = await Promise.all([
          axios.get(`https://api.github.com/repos/${repoName}/contents/${file.filename}?ref=${baseRef}`, { headers }),
          axios.get(`https://api.github.com/repos/${repoName}/contents/${file.filename}?ref=${headRef}`, { headers })
        ]);

        const baseContent = Buffer.from(baseFile.data.content, 'base64').toString();
        const headContent = Buffer.from(headFile.data.content, 'base64').toString();

        // 3. Ask AI to merge the changes
        const prompt = `
There is a merge conflict in the file '${file.filename}'.
I have the content from the base branch ('${baseRef}') and the head branch ('${headRef}').

BASE BRANCH CONTENT:
"""
${baseContent}
"""

HEAD BRANCH CONTENT:
"""
${headContent}
"""

YOUR TASK:
Merge these two versions into a single, clean file. 
Preserve the important changes from both sides if they don't contradict. 
If they do contradict, use your best judgment as a senior engineer to choose the most logical version.
Do not include any git conflict markers (<<<<, ====, >>>>). 
Return ONLY the final file content, nothing else. No markdown blocks.
`;

        const mergedContent = await analyzeWithGemini(prompt);

        // 4. Update the file on the head branch (the PR branch)
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
        
        console.log(`✅ Successfully resolved conflict in ${file.filename}`);
      }
    }

    // 5. Notify the user and attempt merge
    console.log(`Merging PR #${prNumber} in ${repoName}...`);
    
    // Small delay to allow GitHub status to update
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      await axios.put(
        `https://api.github.com/repos/${repoName}/pulls/${prNumber}/merge`,
        {
          commit_title: `🤖 [AI-AUTO-MERGE] Resolved conflicts and merged PR #${prNumber}`,
          merge_method: 'merge'
        },
        { headers }
      );
      
      await axios.post(
        `https://api.github.com/repos/${repoName}/issues/${prNumber}/comments`,
        { body: `✅ [AI-AUTO-MERGE] Conflict resolved and PR successfully merged! 🏁` },
        { headers }
      );
      console.log(`🏁 PR #${prNumber} merged successfully.`);
    } catch (mergeError) {
      console.warn('Auto-merge failed (possibly due to branch protection or CI checks):', mergeError.response ? mergeError.response.data.message : mergeError.message);
      await axios.post(
        `https://api.github.com/repos/${repoName}/issues/${prNumber}/comments`,
        { body: `⚠️ [AI-ADVISOR] Conflict resolved, but auto-merge failed: ${mergeError.response ? mergeError.response.data.message : 'Check branch protections.'}` },
        { headers }
      );
    }

    return true;
  } catch (error) {
    console.error('Conflict resolution failed:', error.response ? error.response.data : error.message);
    return false;
  }
}

module.exports = { performDiagnostics, handleConflict };
