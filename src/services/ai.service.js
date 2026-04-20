const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

dotenv.config();

const axios = require('axios');

async function fetchDiff(repoName, commitId) {
  try {
    const url = `https://github.com/${repoName}/commit/${commitId}.diff`;
    console.log(`Fetching diff from: ${url}`);
    const response = await axios.get(url);
    // Limit diff size to keep prompts manageable
    return response.data.substring(0, 5000); 
  } catch (error) {
    console.warn(`Could not fetch diff for ${commitId}: ${error.message}`);
    return "Diff not available.";
  }
}

/**
 * Analyzes a list of commits using Claude or Gemini.
 */
async function analyzeCommits(commits, repoName) {
  let commitData = "";
  
  for (const c of commits) {
    const diff = await fetchDiff(repoName, c.id);
    commitData += `\n--- COMMIT ${c.id.substring(0, 7)} ---\n`;
    commitData += `Message: ${c.message}\n`;
    commitData += `Author: ${c.author.name}\n`;
    commitData += `Raw Code Changes:\n${diff}\n`;
  }

  const prompt = `
You are CodeNarrator, an Expert Technical PM.
Analyze the following code changes for the repository "${repoName}":

${commitData}

Provide a high-impact, human-readable report.
1. Executive Summary: What was the primary goal of these changes?
2. Technical Breakdown: Explain the specific code logic that was added or improved.
3. Impact: How does this affect the user or the business?
4. Risks: Are there any immediate concerns related to security or stability?

Format the output in a clear, professional way.
`;

  let summary = "";

  if (process.env.ANTHROPIC_API_KEY) {
    summary = await analyzeWithClaude(prompt);
  } else if (process.env.GEMINI_API_KEY) {
    summary = await analyzeWithGemini(prompt);
  } else {
    console.warn('Neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is set. Returning mock analysis.');
    return mockAnalysis(commits, repoName);
  }

  return {
    repoName,
    timestamp: new Date().toISOString(),
    summary,
    commitCount: commits.length
  };
}

async function analyzeWithClaude(prompt) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      system: "You are an expert technical product manager who can translate complex code changes into business value summaries.",
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].text;
  } catch (error) {
    console.error('Error calling Claude API:', error);
    throw error;
  }
}

async function analyzeWithGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  const models = ['gemini-3-flash-preview', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-pro'];
  const versions = ['v1beta', 'v1'];

  const requestBody = {
    contents: [{
      parts: [{ text: `System: You are an expert technical product manager who can translate complex code changes into business value summaries.\n\nUser: ${prompt}` }]
    }]
  };

  for (const model of models) {
    for (const version of versions) {
      const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent`;
      try {
        console.log(`Trying Gemini 3/Flash: ${version}/${model}...`);
        const response = await axios.post(url, requestBody, {
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          }
        });
        const text = response.data.candidates[0].content.parts[0].text;
        console.log(`Success! Using ${version}/${model}`);
        return text;
      } catch (error) {
        if (error.response && error.response.status === 429) {
          console.warn(`⚠️ Rate limit hit for ${model}. Waiting 5 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        console.error(`Gemini Error (${error.response ? error.response.status : 'Local'}):`, error.response ? JSON.stringify(error.response.data) : error.message);
      }
    }
  }

  throw new Error('All Gemini models (including Gemini 3) failed. Please check your API key.');
}

function mockAnalysis(commits, repoName) {
  return {
    repoName,
    timestamp: new Date().toISOString(),
    summary: "MOCK ANALYSIS: This is a placeholder since no API key was provided.\n\n" +
             "EXECUTIVE SUMMARY: The team implemented several features related to project setup and core architecture.\n" +
             "IMPACT: Provides the foundation for the CodeNarrator platform.\n" +
             "RISKS: Low priority, primarily infrastructure setup.",
    commitCount: commits.length
  };
}

module.exports = { analyzeCommits, analyzeWithGemini };
