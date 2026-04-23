import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const ANALYSIS_SCHEMA = `
{
  "summary": "High-level overview",
  "confidence": 0-100,
  "impactLevel": "Low|Medium|High",
  "rootCause": "Deep dive into why it failed",
  "errorType": "Category of error",
  "errorLocation": "file:line",
  "whyItWorks": "Technical explanation of fix",
  "confidenceBreakdown": {
    "syntaxCorrectness": 0-100,
    "logicValidation": 0-100,
    "bestPractices": 0-100,
    "testCoverageImpact": 0-100
  },
  "linesAdded": number,
  "linesRemoved": number,
  "functionsAffected": number,
  "dependenciesModified": boolean,
  "breakingChanges": boolean,
  "breakingChangesDescription": "string",
  "deploymentRisk": "Low|Medium|High",
  "affectedSystems": ["system1", "system2"],
  "buildStatus": "Success|Failed",
  "buildTime": "string",
  "warnings": [{"title": "string", "severity": "Low|Medium|High", "description": "string", "recommendation": "string"}],
  "suggestions": ["string"],
  "immediateActions": ["action1"],
  "status": "PROCEED|PROCEED WITH CAUTION|REQUIRES REVIEW|DO NOT MERGE"
}
`;

export async function fetchDiff(repoName, commitId) {
  try {
    const url = `https://github.com/${repoName}/commit/${commitId}.diff`;
    const response = await axios.get(url);
    return response.data.substring(0, 5000); 
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

  const prompt = `Analyze these changes for ${repoName}.\nReturn ONLY JSON matching this schema: ${ANALYSIS_SCHEMA}\n\nCHANGES:\n${commitData}`;
  const rawAnalysis = await analyzeWithGemini(prompt);
  const analysis = JSON.parse(rawAnalysis.replace(/```json|```/g, '').trim());

  // Enrich with GitHub metadata
  return {
    ...analysis,
    owner: repoName.split('/')[0],
    repo: repoName.split('/')[1],
    commitSha: commits[0]?.id,
    branch,
    author,
    timestamp: new Date().toISOString(),
    filesChanged: [], // To be populated by commit diff analysis if needed
    autoFixApplied: false,
    githubUrl: `https://github.com/${repoName}/commit/${commits[0]?.id}`,
    aiModel: 'gemini-3-flash-preview',
    analysisTime: '3.5s'
  };
}

export async function analyzeWithGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = 'gemini-3-flash-preview';
  
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error(`AI Error:`, error.message);
    throw error;
  }
}
