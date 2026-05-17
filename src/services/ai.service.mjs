import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================
//  ANALYSIS SCHEMA (retained for backward compatibility with
//  the webhook commit-analysis pipeline)
// ============================================================
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

// ============================================================
//  TOOL SCHEMA CONVERTERS
//  Ulla stores tools in Gemini's native format internally.
//  When routing to Groq/OpenRouter (OpenAI-compatible), we
//  convert on the fly.
// ============================================================

/**
 * Convert Gemini-format tool declarations to OpenAI function-calling format.
 */
function toOpenAITools(geminiTools) {
    const openAITools = [];
    for (const group of geminiTools) {
        for (const fn of (group.functionDeclarations || [])) {
            openAITools.push({
                type: 'function',
                function: {
                    name: fn.name,
                    description: fn.description,
                    parameters: fn.parameters || { type: 'object', properties: {} }
                }
            });
        }
    }
    return openAITools;
}

// ============================================================
//  AI GATEWAY — Core Class
// ============================================================
class AIGateway {
    constructor() {
        // ── Provider Clients ──────────────────────────────────
        this.gemini = process.env.GEMINI_API_KEY
            ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
            : null;

        this.groq = process.env.GROQ_API_KEY
            ? new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY })
            : null;

        this.openrouter = process.env.OPENROUTER_API_KEY
            ? new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY })
            : null;

        // ── Circuit Breakers (per provider) ──────────────────
        this.breakers = {
            gemini:     { failures: 0, lastFailure: null, isOpen: false },
            groq:       { failures: 0, lastFailure: null, isOpen: false },
            openrouter: { failures: 0, lastFailure: null, isOpen: false }
        };

        // ── Model Config ──────────────────────────────────────
        this.models = {
            gemini:     { primary: 'gemini-3-flash-preview', fallback: 'gemini-1.5-flash' },
            groq:       { primary: 'llama-3.3-70b-versatile', fallback: 'llama-3.1-8b-instant' },
            openrouter: { primary: 'meta-llama/llama-3.3-70b-instruct:free', fallback: 'google/gemini-2.0-flash-lite-preview-02-05:free' }
        };

        // ── Usage Tracking ────────────────────────────────────
        this.usageLog = [];

        console.log('[AI Gateway] 🚀 Initialized. Providers active:', [
            this.gemini     ? 'Gemini'     : null,
            this.groq       ? 'Groq'       : null,
            this.openrouter ? 'OpenRouter' : null,
        ].filter(Boolean).join(' → '));
    }

    // ──────────────────────────────────────────────────────────
    //  SMART ROUTING: Decide which provider handles a request
    // ──────────────────────────────────────────────────────────
    selectProvider(options = {}) {
        if (options.provider) return options.provider; // Explicit override

        if (options.speed === 'fast') return 'groq';          // Speed-priority → Groq
        if (options.complexity === 'high') return 'gemini';   // Complex reasoning → Gemini
        if (options.cost === 'minimize') return 'openrouter'; // Cost-sensitive → OpenRouter free

        return 'gemini'; // Default
    }

    // ──────────────────────────────────────────────────────────
    //  CIRCUIT BREAKER
    // ──────────────────────────────────────────────────────────
    isBreakerOpen(provider) {
        const b = this.breakers[provider];
        if (!b.isOpen) return false;
        // Auto-reset after 60 seconds
        if (Date.now() - b.lastFailure > 60_000) {
            b.isOpen = false;
            b.failures = 0;
            console.log(`[AI Gateway] ✅ Circuit breaker RESET for ${provider}`);
            return false;
        }
        return true;
    }

    recordSuccess(provider) {
        this.breakers[provider].failures = 0;
        this.breakers[provider].isOpen = false;
    }

    recordFailure(provider) {
        const b = this.breakers[provider];
        b.failures++;
        b.lastFailure = Date.now();
        if (b.failures >= 3) {
            b.isOpen = true;
            console.warn(`[AI Gateway] ⚡ Circuit breaker OPEN for ${provider} (${b.failures} failures)`);
        }
    }

    // ──────────────────────────────────────────────────────────
    //  TELEMETRY & COST TRACKING
    // ──────────────────────────────────────────────────────────
    trackUsage({ provider, model, tokens, latency, success, error }) {
        const entry = {
            ts: new Date().toISOString(),
            provider, model,
            tokens: tokens || 0,
            latencyMs: latency || 0,
            success,
            error: error || null
        };
        this.usageLog.push(entry);
        // Keep last 100 entries in memory
        if (this.usageLog.length > 100) this.usageLog.shift();

        const icon = success ? '✅' : '❌';
        console.log(`[AI Gateway] ${icon} ${provider}/${model} | ${tokens || '?'} tokens | ${latency || '?'}ms`);
    }

    getUsageStats() {
        const byProvider = {};
        for (const e of this.usageLog) {
            if (!byProvider[e.provider]) byProvider[e.provider] = { calls: 0, tokens: 0, errors: 0 };
            byProvider[e.provider].calls++;
            byProvider[e.provider].tokens += e.tokens;
            if (!e.success) byProvider[e.provider].errors++;
        }
        return byProvider;
    }

    // ──────────────────────────────────────────────────────────
    //  GEMINI: Simple generateContent (no tool calling)
    // ──────────────────────────────────────────────────────────
    async _callGeminiGenerate(prompt, modelName) {
        const model = this.gemini.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    // ──────────────────────────────────────────────────────────
    //  GROQ / OPENROUTER: Simple generateContent (no tool calling)
    // ──────────────────────────────────────────────────────────
    async _callOpenAIGenerate(client, prompt, modelName) {
        const completion = await client.chat.completions.create({
            model: modelName,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4096
        });
        return completion.choices[0].message.content;
    }

    // ──────────────────────────────────────────────────────────
    //  PUBLIC: generateContent — used by analyzeCommits, etc.
    //  Tries providers in order: preferred → Groq → OpenRouter
    // ──────────────────────────────────────────────────────────
    async generateContent(prompt, options = {}) {
        const preferred = this.selectProvider(options);
        const chain = [preferred, ...['gemini', 'groq', 'openrouter'].filter(p => p !== preferred)];

        for (const provider of chain) {
            if (this.isBreakerOpen(provider)) {
                console.log(`[AI Gateway] ⏭️ Skipping ${provider} (circuit open)`);
                continue;
            }

            const client = this[provider];
            if (!client) continue;

            const modelName = this.models[provider].primary;
            const start = Date.now();

            try {
                console.log(`[AI Gateway] 🤖 generateContent via ${provider}/${modelName}`);
                let text;

                if (provider === 'gemini') {
                    text = await this._callGeminiGenerate(prompt, modelName);
                } else {
                    text = await this._callOpenAIGenerate(client, prompt, modelName);
                }

                this.recordSuccess(provider);
                this.trackUsage({ provider, model: modelName, latency: Date.now() - start, success: true });
                return text;

            } catch (err) {
                const is429or503 = err?.status === 429 || err?.status === 503
                    || err?.message?.includes('429') || err?.message?.includes('503')
                    || err?.message?.includes('rate limit') || err?.message?.includes('Service Unavailable');

                this.recordFailure(provider);
                this.trackUsage({ provider, model: modelName, latency: Date.now() - start, success: false, error: err.message });

                console.warn(`[AI Gateway] ⚠️ ${provider} failed (${err.message?.substring(0, 60)}). Trying next provider...`);

                if (!is429or503) throw err; // Propagate non-rate-limit errors immediately
            }
        }

        throw new Error('[AI Gateway] All providers exhausted. Unable to complete request.');
    }

    // ──────────────────────────────────────────────────────────
    //  GEMINI CHAT: Start a persistent tool-calling chat session
    //  Used by ChatService for the main agentic loop
    // ──────────────────────────────────────────────────────────
    getGeminiModel(tools) {
        if (!this.gemini) throw new Error('Gemini client not initialized. Check GEMINI_API_KEY.');
        return this.gemini.getGenerativeModel({
            model: this.models.gemini.primary,
            tools
        });
    }

    // ──────────────────────────────────────────────────────────
    //  GROQ/OPENROUTER CHAT: Tool-calling completion (stateless)
    //  Returns { text, toolCalls } to match the agentic loop interface
    // ──────────────────────────────────────────────────────────
    async _callOpenAIChat(client, modelName, messages, openAITools) {
        const payload = {
            model: modelName,
            messages,
            max_tokens: 4096,
        };
        if (openAITools && openAITools.length > 0) {
            payload.tools = openAITools;
            payload.tool_choice = 'auto';
        }
        const completion = await client.chat.completions.create(payload);
        const msg = completion.choices[0].message;
        return {
            text: msg.content || '',
            toolCalls: msg.tool_calls || []
        };
    }

    // ──────────────────────────────────────────────────────────
    //  PUBLIC: agentChat — provider-aware, tool-calling capable
    //  This is the unified interface ChatService uses.
    //  Returns: { text, toolCalls, provider }
    // ──────────────────────────────────────────────────────────
    async agentChat(messages, geminiTools, options = {}) {
        const chain = ['gemini', 'groq', 'openrouter'];
        const openAITools = toOpenAITools(geminiTools);

        for (const provider of chain) {
            if (this.isBreakerOpen(provider)) {
                console.log(`[AI Gateway] ⏭️ Skipping ${provider} (circuit open)`);
                continue;
            }
            const client = this[provider];
            if (!client) continue;

            const modelName = this.models[provider].primary;
            const start = Date.now();

            try {
                console.log(`[AI Gateway] 🧠 agentChat via ${provider}/${modelName}`);
                let result;

                if (provider === 'gemini') {
                    // Gemini uses its own session-based chat — caller manages the session
                    // This method is a fallback wrapper; Gemini sessions are managed by ChatService
                    throw new Error('Gemini session routing is managed by ChatService directly.');
                } else {
                    result = await this._callOpenAIChat(client, modelName, messages, openAITools);
                }

                this.recordSuccess(provider);
                this.trackUsage({ provider, model: modelName, latency: Date.now() - start, success: true });
                return { ...result, provider };

            } catch (err) {
                // If it's a Gemini session routing skip, just move on
                if (err.message.includes('managed by ChatService')) {
                    continue;
                }

                this.recordFailure(provider);
                this.trackUsage({ provider, model: modelName, latency: Date.now() - start, success: false, error: err.message });
                console.warn(`[AI Gateway] ⚠️ ${provider} failed: ${err.message?.substring(0, 80)}`);
            }
        }

        throw new Error('[AI Gateway] All providers exhausted for agentChat.');
    }
}

// ============================================================
//  SINGLETON EXPORT
// ============================================================
const aiGateway = new AIGateway();
export default aiGateway;

// ============================================================
//  BACKWARD-COMPAT: exported functions used by webhook pipeline
// ============================================================

export async function fetchDiff(repoName, commitId) {
    try {
        const url = `https://github.com/${repoName}/commit/${commitId}.diff`;
        const response = await axios.get(url);
        return response.data.substring(0, 8000);
    } catch {
        return 'Diff not available.';
    }
}

export async function analyzeWithGemini(prompt) {
    return aiGateway.generateContent(prompt, { complexity: 'high' });
}

export async function analyzeCommits(commits, repoName, branch = 'main', author = 'Unknown') {
    let commitData = '';
    for (const c of commits) {
        const diff = await fetchDiff(repoName, c.id);
        commitData += `\n--- COMMIT ${c.id.substring(0, 7)} ---\nMessage: ${c.message}\nDiff:\n${diff}\n`;
    }

    const prompt = `Analyze these changes for ${repoName}. Return ONLY JSON matching this schema: ${ANALYSIS_SCHEMA}\n\nCHANGES:\n${commitData}`;
    const rawAnalysis = await aiGateway.generateContent(prompt, { complexity: 'high' });

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
            aiModel: 'ai-gateway',
            analysisTime: '~'
        };
    } catch (e) {
        console.error('AI JSON Parse Error:', e.message);
        return { summary: 'Analysis failed to parse.', confidence: 0, status: 'REQUIRES REVIEW' };
    }
}
