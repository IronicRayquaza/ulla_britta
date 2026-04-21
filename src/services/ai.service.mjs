import { GoogleGenerativeAI } from "@google/generative-ai";
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

  const prompt = `Analyze these changes for ${repoName} and provide a formal DevOps report. Highlight any potential risks or improvements.\n\nCHANGES:\n${commitData}`;
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
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const genAI = new GoogleGenerativeAI(apiKey);
  
  // Set to EXACT model name requested by user
  const modelName = 'gemini-3-flash-preview';
  
  try {
    console.log(`🤖 Consulting ${modelName}...`);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error(`AI Error (${modelName}):`, error.message);
    throw new Error(`Failed to consult ${modelName}: ${error.message}`);
  }
}
