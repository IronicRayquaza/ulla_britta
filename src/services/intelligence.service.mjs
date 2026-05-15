import { GoogleGenerativeAI } from '@google/generative-ai';
import githubService from './github.service.mjs';
import databaseService from './database.service.mjs';
import logger from './logger.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * 🧠 General Intelligence Layer
 * 
 * Transforms vague user intent into structured, multi-step execution plans.
 * This is the "thinking" layer that sits between the user and the executor.
 * 
 * Workflow:
 * 1. classify() - Determines if a message is vague or specific
 * 2. gatherContext() - Scans all repos to understand the user's GitHub state
 * 3. reason() - Uses Gemini to generate a structured execution plan
 * 4. formatPlan() - Returns a human-readable plan for approval or execution
 */
class IntelligenceService {

    constructor() {
        this.reasoningModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    }

    /**
     * Determines if a message is vague (needs intelligence layer) or specific (can be handled directly).
     * Returns: 'vague' | 'specific'
     */
    classify(message) {
        try {
            const vaguePatterns = [
                /make.*better/i,
                /fix.*everything/i,
                /clean.*up/i,
                /improve.*repo/i,
                /make.*production.ready/i,
                /audit.*everything/i,
                /analyze.*all/i,
                /check.*everything/i,
                /optimize/i,
                /make.*repos.*good/i,
                /what.*wrong/i,
                /help me.*become/i,
                /i want to learn/i,
                /enable autopilot/i,
                /start autopilot/i,
                /what should i work on/i,
                /give me.*summary of everything/i,
                /overall.*health/i,
                /^audit$/i,
                /^optimize$/i,
            ];

            const isVague = vaguePatterns.some(p => p.test(message));
            console.log(`[INTELLIGENCE] Message classified as: ${isVague ? 'VAGUE' : 'SPECIFIC'}`);
            return isVague ? 'vague' : 'specific';
        } catch (e) {
            console.error('[INTELLIGENCE] Classify Error:', e);
            return 'specific'; // Fallback to standard flow
        }
    }

    /**
     * Gathers full GitHub context: all repos, their health signals, recent activity.
     */
    async gatherContext(userId) {
        try {
            await logger.info('🔍 Gathering full GitHub context for intelligent analysis...');
            
            // [DYNAMIC RESOLUTION] Find the best installation client for this user
            const installationId = await databaseService.getInstallationIdByRepo('', userId);
            const client = installationId 
                ? await githubService.getClient(installationId)
                : await githubService.getClientForOrg('ulla-labs');

            // Fetch all repos
            const repos = await githubService.listUserRepos(client);
            if (!repos || !Array.isArray(repos)) return [];

            // Enrich each repo with basic health signals
            const enriched = repos.map(repo => {
                const pushedAt = new Date(repo.pushed_at);
                const now = new Date();
                const daysSinceLastPush = Math.floor((now - pushedAt) / (1000 * 60 * 60 * 24));

                return {
                    name: repo.full_name,
                    description: repo.description,
                    daysSinceLastPush,
                    isStale: daysSinceLastPush > 180,
                    pushed_at: repo.pushed_at,
                };
            });

            await logger.info(`⚙️ Context gathered: ${enriched.length} repositories scanned.`);
            return enriched;
        } catch (e) {
            await logger.warn(`⚠️ Context gathering failed: ${e.message}. Proceeding with empty context.`);
            return [];
        }
    }

    /**
     * The core reasoning engine. Takes user intent + repo context and generates
     * a structured JSON plan of actions to take.
     */
    async reason(userMessage, repoContext) {
        await logger.info('🧠 Reasoning engine activated. Formulating execution plan...');

        const contextSummary = repoContext.length > 0
            ? repoContext.map(r => `- ${r.name}: Last push ${r.daysSinceLastPush}d ago${r.isStale ? ' (STALE)' : ''}`).join('\n')
            : 'No repo context available. Proceed with general recommendations.';

        const reasoningPrompt = `
You are Ulla Britta's reasoning engine. A user has made a vague request and you must create a specific, actionable plan.

USER REQUEST: "${userMessage}"

CURRENT GITHUB STATE:
${contextSummary}

Your task: Analyze the user's intent and the current GitHub state, then generate a structured JSON execution plan.

Respond with ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "interpretation": "What I understand the user wants (1-2 sentences)",
  "analysis": "What I found in their repos that's relevant (2-3 sentences)",
  "plan": [
    {
      "step": 1,
      "action": "tool_name",
      "target": "repo_name_or_null",
      "description": "What this step does for the user",
      "priority": "high|medium|low"
    }
  ],
  "summary": "A short human-friendly summary of the plan (1 sentence)",
  "requiresApproval": true
}

Available actions: check_repo_health, update_dependencies, clean_stale_issues, generate_changelog, summarize_latest_commit, build_feature, list_user_repositories

Be specific. If you see stale repos, include clean_stale_issues. If context suggests outdated code, include update_dependencies. Keep the plan to 3-5 focused steps max.
        `;

        try {
            const result = await this.reasoningModel.generateContent(reasoningPrompt);
            const rawText = result.response.text().trim();

            // Strip any accidental markdown code fences
            const jsonText = rawText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
            const plan = JSON.parse(jsonText);

            await logger.info(`🛠️ Execution plan formulated: ${plan.plan.length} steps identified.`);
            return plan;
        } catch (e) {
            await logger.warn(`⚠️ Reasoning engine parse error: ${e.message}. Using fallback plan.`);
            // Fallback: a sensible default plan
            return {
                interpretation: "You want a comprehensive overview of your repositories.",
                analysis: "I will audit your repos for health issues and outdated dependencies.",
                plan: [
                    { step: 1, action: "list_user_repositories", target: null, description: "Scan all your repositories", priority: "high" },
                ],
                summary: "I'll start with a full repository audit.",
                requiresApproval: false
            };
        }
    }

    /**
     * Master method: Takes a vague message and returns a formatted plan string
     * ready to be shown to the user OR executed directly.
     */
    async thinkAndPlan(userId, message) {
        logger.setContext(userId, null, 'intelligence-engine');
        
        const repoContext = await this.gatherContext(userId);
        const plan = await this.reason(message, repoContext);

        // Format the plan for the chat response
        const stepsList = plan.plan.map(s =>
            `  ${s.step}. **${s.description}** _(${s.priority} priority)_`
        ).join('\n');

        const formatted = `
**🧠 Understood:** ${plan.interpretation}

**🔍 Analysis:** ${plan.analysis}

**📋 My Plan (${plan.plan.length} steps):**
${stepsList}

${plan.requiresApproval
    ? `> ⚠️ **This plan requires your approval before execution.** Reply **"yes execute"** to proceed, or tell me to adjust the plan.`
    : `> ⚡ Executing immediately...`
}
        `.trim();

        return { formatted, plan, repoContext };
    }
}

export default new IntelligenceService();
