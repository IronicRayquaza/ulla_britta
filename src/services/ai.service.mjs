import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import crypto from 'crypto';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const ANALYSIS_SCHEMA = `
{
  "summary": "String",
  "confidence": 0-100,
  "impactLevel": "Low|Medium|High",
  "rootCause": "String",
  "errorType": "String",
  "errorLocation": "String",
  "whyItWorks": "String",
  "filesChanged": [{ "path": "string", "additions": number, "deletions": number, "language": "string" }],
  "confidenceBreakdown": { "syntaxCorrectness": 0-100, "logicValidation": 0-100, "bestPractices": 0-100, "testCoverageImpact": 0-100 },
  "linesAdded": number,
  "linesRemoved": number,
  "functionsAffected": number,
  "dependenciesModified": boolean,
  "breakingChanges": boolean,
  "breakingChangesDescription": "string",
  "deploymentRisk": "Low|Medium|High",
  "affectedSystems": ["string"],
  "buildStatus": "Success|Failed",
  "buildTime": "string",
  "warnings": [{"title": "string", "severity": "Low|Medium|High", "description": "string", "recommendation": "string"}],
  "suggestions": ["string"],
  "immediateActions": ["string"],
  "status": "PROCEED|PROCEED WITH CAUTION|REQUIRES REVIEW|DO NOT MERGE"
}
`;

export async function fetchDiff(repoName, commitId) {
  try {
    const url = `https://github.com/${repoName}/commit/${commitId}.diff`;
    const response = await axios.get(url);
    return response.data.substring(0, 8000); 
  } catch (error) {
    return "Diff not available.";
  }
}

export async function analyzeCommits(commits, repoName, branch = 'main', author = 'Unknown') {
  let commitData = "";
  for (const c of commits) {
    const diff = await fetchDiff(repoName, c.id);
    commitData += `\n--- COMMIT ${c.id.substring(0, 7)} ---\nMessage: ${c.message}\nDiff:\n${diff}\n`;
  }

  const prompt = `Analyze these changes for ${repoName}. Return ONLY JSON matching this schema: ${ANALYSIS_SCHEMA}\n\nCHANGES:\n${commitData}`;
  const rawAnalysis = await analyzeWithGemini(prompt);
  
  try {
    const analysis = JSON.parse(rawAnalysis.replace(/```json|```/g, '').trim());
    return {
      ...analysis,
      owner: repoName.split('/')[0],
      repo: repoName.split('/')[1],
      commitSha: commits[0]?.id,
      branch,
      author,
      timestamp: new Date().toISOString(),
      autoFixApplied: false,
      githubUrl: `https://github.com/${repoName}/commit/${commits[0]?.id}`,
      aiModel: 'gemini-3-flash-preview',
      analysisTime: '3.8s'
    };
  } catch (e) {
    console.error('AI JSON Parse Error:', e.message);
    return { summary: 'Analysis failed to parse.', confidence: 0, status: 'REQUIRES REVIEW' };
  }
}

export async function analyzeWithGemini(prompt) {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-3-flash-preview',
    systemInstruction: "You are Ulla Britta, an elite SRE Agent. You must always use FULL, ABSOLUTE repository paths for all files (e.g., 'folder/subfolder/file.js'). Never assume files are at the root. Your analysis must be surgical, non-technical for executive summaries, and strictly grounded in the provided project structure."
  });
  
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error(`AI Error:`, error.message);
    throw error;
  }
}
