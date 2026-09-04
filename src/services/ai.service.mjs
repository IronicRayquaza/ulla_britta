import axios from 'axios';
import router from '../providers/index.mjs';
import { system, user } from '../providers/messages.mjs';

/**
 * Plain text generation for the webhook pipeline (commit analysis, build healing,
 * code generation).
 *
 * This used to be a second, parallel AI gateway with its own circuit breaker, its
 * own failover chain, and an agentChat() whose Gemini branch threw on purpose and
 * whose tool calls were discarded by the only caller. All of that now lives in
 * src/providers, so this is just the text-generation entry point.
 */

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

/** Generates text, failing over between providers as needed. */
export async function generateText(prompt, { systemPrompt = null } = {}) {
    const messages = systemPrompt ? [system(systemPrompt), user(prompt)] : [user(prompt)];
    const result = await router.complete({ messages, tools: [] });
    return result.text;
}

export async function analyzeWithGemini(prompt) {
    return generateText(prompt);
}

export async function fetchDiff(repoName, commitId) {
    try {
        const url = `https://github.com/${repoName}/commit/${commitId}.diff`;
        const response = await axios.get(url);
        return response.data.substring(0, 8000);
    } catch {
        return 'Diff not available.';
    }
}

/** Strips markdown fences a model may wrap JSON in. */
function parseJsonResponse(raw) {
    const cleaned = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
}

export async function analyzeCommits(commits, repoName, branch = 'main', author = 'Unknown') {
    let commitData = '';
    for (const c of commits) {
        const diff = await fetchDiff(repoName, c.id);
        commitData += `\n--- COMMIT ${c.id.substring(0, 7)} ---\nMessage: ${c.message}\nDiff:\n${diff}\n`;
    }

    const prompt = `Analyze these changes for ${repoName}. Return ONLY JSON matching this schema: ${ANALYSIS_SCHEMA}\n\nCHANGES:\n${commitData}`;
    const raw = await generateText(prompt);

    try {
        const analysis = parseJsonResponse(raw);
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
            analysisTime: '~'
        };
    } catch (e) {
        // Say the analysis failed rather than emitting a confident-looking empty report.
        console.error('AI JSON parse error:', e.message);
        return {
            summary: 'The analysis could not be parsed and no conclusions were drawn.',
            confidence: 0,
            status: 'REQUIRES REVIEW',
            parseError: e.message,
            owner: repoName.split('/')[0],
            repo: repoName.split('/')[1],
            commitSha: commits[0]?.id,
            branch,
            author,
            timestamp: new Date().toISOString()
        };
    }
}

export default { generateText, analyzeWithGemini, analyzeCommits, fetchDiff };
