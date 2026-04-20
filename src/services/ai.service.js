import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

export async function fetchDiff(repoName, commitId) {
  try {
    const url = `https://github.com/${repoName}/commit/${commitId}.diff`;
    const response = await axios.get(url);
    return response.data.substring(0, 5000); 
  } catch (error) {
    console.warn(`Could not fetch diff for ${commitId}: ${error.message}`);
    return "Diff not available.";
  }
}

export async function analyzeCommits(commits, repoName) {
  let commitData = "";
  for (const c of commits) {
    const diff = await fetchDiff(repoName, c.id);
    commitData += `\n--- COMMIT ${c.id.substring(0, 7)} ---\nMessage: ${c.message}\nDiff:\n${diff}\n`;
  }

  const prompt = `Analyze these changes for ${repoName}:\n${commitData}\nProvide a technical report.`;
  const summary = await analyzeWithGemini(prompt);

  return {
    repoName,
    timestamp: new Date().toISOString(),
    summary,
    commitCount: commits.length
  };
}

export async function analyzeWithGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  const versions = ['v1beta', 'v1'];

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }]
  };

  for (const model of models) {
    for (const version of versions) {
      const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`;
      try {
        const response = await axios.post(url, requestBody);
        return response.data.candidates[0].content.parts[0].text;
      } catch (error) {
        if (error.response?.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }
  throw new Error('All Gemini models failed.');
}
