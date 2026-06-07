import { GoogleGenerativeAI } from '@google/generative-ai';
import aiGateway from './ai.service.mjs';
import repoCreatorService from './repo-creator.service.mjs';
import databaseService from './database.service.mjs';
import githubService from './github.service.mjs';
import { sendEmail } from './email.service.mjs';
import advancedWorkflowsService from './advanced-workflows.service.mjs';
import logger from './logger.service.mjs';
import intelligenceService from './intelligence.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Integrated Chat Agent with "Search & Act" Autonomy
 * Powered by a General Intelligence Layer for vague/complex requests.
 */
class ChatService {
    constructor() {
        // [MEMORY] Persistent chat sessions per user
        this.sessions = new Map();
        
        // Pending plan awaiting user approval { plan, repoContext }
        this.pendingPlan = null;
        this.autopilotActive = false;
        this.tools = [
            {
                functionDeclarations: [
                    {
                        name: "autonomous_discovery",
                        description: "Finds and acts on repositories based on a broad intent (e.g. 'find and fork 3 AI repos').",
                        parameters: {
                            type: "object",
                            properties: {
                                topic: { type: "string" },
                                action: { type: "string", enum: ["star", "fork"] },
                                count: { type: "number" }
                            },
                            required: ["topic", "action"]
                        }
                    },
                    {
                        name: "push_custom_file",
                        description: "Creates or updates a single specific file in a repository with custom content. Use this for CI/CD workflows, config files, or one-off document creation.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string", description: "Full repository name, e.g. ulla-labs/my-repo" },
                                path: { type: "string", description: "The file path including filename, e.g. .github/workflows/ci.yml" },
                                content: { type: "string", description: "The full content of the file to be created" },
                                commitMessage: { type: "string", description: "A descriptive commit message" }
                            },
                            required: ["repoName", "path", "content", "commitMessage"]
                        }
                    },
                    {
                        name: "create_repository",
                        description: "Creates a NEW repository. Use this for scaffolding new projects.",
                        parameters: {
                            type: "object",
                            properties: {
                                prompt: { type: "string" },
                                techStack: { type: "string" }
                            },
                            required: ["prompt", "techStack"]
                        }
                    },
                    {
                        name: "summarize_latest_commit",
                        description: "Summarizes the latest commit for a given repository and emails the report.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string", description: "The name of the repository (e.g. ulla-labs/my-repo or just my-repo)" }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "mail_repo_files",
                        description: "Fetches the contents of specific files in a repository and emails them to the user. Use this when the user asks to 'mail the files'.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string", description: "Full repository name, e.g. ulla-labs/my-repo" },
                                files: { 
                                    type: "array", 
                                    items: { type: "string" },
                                    description: "List of file paths to email. If empty, the agent will pick the most important ones (README, src files)."
                                }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "mail_custom_content",
                        description: "Sends an email to the user containing custom text or code generated during the chat. Use this when the user asks to email them a workflow, script, or summary that hasn't been pushed to GitHub.",
                        parameters: {
                            type: "object",
                            properties: {
                                subject: { type: "string", description: "The subject line/title of the content, e.g. Generated CI/CD Workflow" },
                                content: { type: "string", description: "The full markdown or code content to email" }
                            },
                            required: ["subject", "content"]
                        }
                    },
                    {
                        name: "review_pull_request",
                        description: "Analyzes a PR diff and posts inline comments or a general review.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string" },
                                prNumber: { type: "number" }
                            },
                            required: ["repoName", "prNumber"]
                        }
                    },
                    {
                        name: "update_dependencies",
                        description: "Checks package.json for outdated dependencies and provides a summary.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string" }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "check_repo_health",
                        description: "Calculates a health score based on basic metrics and emails the report.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string" }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "generate_changelog",
                        description: "Generates a changelog from recent commits for a given repository.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string" }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "clean_stale_issues",
                        description: "Finds issues older than 30 days and posts a warning comment.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string" }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "resolve_merge_conflicts",
                        description: "Analyzes PRs with dirty states and attempts to resolve conflicts using Gemini.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string" },
                                prNumber: { type: "number" }
                            },
                            required: ["repoName", "prNumber"]
                        }
                    },
                    {
                        name: "build_feature",
                        description: "Triggers Ulla Britta to build a new feature or fix on an existing repository.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string", description: "The full repository name, e.g. ulla-labs/my-repo" },
                                featureDescription: { type: "string", description: "Detailed description of what to build" }
                            },
                            required: ["repoName", "featureDescription"]
                        }
                    },
                    {
                        name: "get_repository_readme",
                        description: "Fetches the README content of a repository for deep analysis and summarization.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string", description: "The full repository name, e.g. ulla-labs/my-repo" }
                            },
                            required: ["repoName"]
                        }
                    },
                    {
                        name: "list_user_repositories",
                        description: "Lists all repositories in the user's account with their last push date for cleanup analysis.",
                        parameters: { type: "object", properties: {} }
                    },
                    {
                        name: "delete_repository",
                        description: "DELETES a repository. This is permanent. USE WITH EXTREME CAUTION.",
                        parameters: {
                            type: "object",
                            properties: {
                                repoName: { type: "string", description: "The full repository name, e.g. ulla-labs/my-repo" }
                            },
                            required: ["repoName"]
                        }
                    }
                ]
            }
        ];

        // Primary model: gemini-2.5-flash-lite via AI Gateway
        // Fallback: Groq → OpenRouter (handled by aiGateway on circuit-breaker trip)
        this.model = aiGateway.getGeminiModel(this.tools);
    }

    async processMessage(userId, message) {
        try {
            logger.setContext(userId, null, 'chat-processor');
            await logger.info(`📥 Neural link received message: "${message.substring(0, 50)}..."`);

            // [INTELLIGENCE LAYER] Check if user is approving a pending plan
            const isApproval = /^(yes|yes execute|execute|confirm|go ahead|proceed|do it|run it)/i.test(message.trim());
            if (isApproval && this.pendingPlan) {
                await logger.info('🧠 User approval detected. Initiating multi-step plan execution...');
                const result = await this.executePlan(userId, this.pendingPlan);
                this.pendingPlan = null;
                return result;
            }

            // [INTELLIGENCE LAYER] Classify message: vague vs specific
            const messageType = intelligenceService.classify(message);
            await logger.info(`🔍 Intent classification: ${messageType.toUpperCase()}`);

            if (messageType === 'vague') {
                await logger.info('🧠 Vague intent detected. Engaging Intelligence Layer for planning...');
                const { formatted, plan } = await intelligenceService.thinkAndPlan(userId, message);
                this.pendingPlan = plan; // Store for approval
                return formatted;
            }

            // Specific request — standard tool-calling flow
            await logger.info('⚡ Specific intent detected. Consulting tool manifest...');
            const context = await databaseService.getRecentActivity(userId, 5);
            
            // [MEMORY] Get or create session for this user
            if (!this.sessions.has(userId)) {
                this.sessions.set(userId, this.model.startChat());
            }
            const chat = this.sessions.get(userId);

            const systemInstruction = `
                You are Ulla Britta, an SRE Agent. You are DIRECT, EFFICIENT, and CAPABLE.

                ## CORE RULES — FOLLOW EXACTLY:
                1. Call only the tools that are directly requested or logically required to fulfill the user's full instruction.
                2. If the user asks for a multi-step request (e.g. "fork X and build feature Y"), you MUST call the tools in sequence (e.g. first autonomous_discovery with action "fork", and once that completes successfully, call build_feature on the resulting repository in the next turn).
                3. DO NOT chain extra or unrelated tools that the user did not ask for.
                4. If the user asks to push a CI/CD file → call ONLY push_custom_file. Then STOP and explain what you pushed.
                5. If the user asks to summarize a commit → call ONLY summarize_latest_commit. Then STOP.
                6. NEVER call get_repository_readme or list_user_repositories unless the user explicitly asks for it or it is absolutely necessary to examine a repository's structure to fulfill a build request.
                7. If a repoName is in the user's message, USE IT DIRECTLY. Do not look it up first.
                8. If no repo is mentioned, use the most recently updated one from Current Status below.
                9. When all parts of the user's instructions are fulfilled, summarize your actions and STOP.

                Current Status (use these repos directly): ${JSON.stringify(context)}
            `;

            let result;
            try {
                result = await chat.sendMessage([
                    { text: systemInstruction },
                    { text: message }
                ]);
            } catch (initErr) {
                // Gemini unavailable — fallback to Groq/OpenRouter via AI Gateway
                const is429or503 = initErr?.status === 429 || initErr?.status === 503
                    || initErr?.message?.includes('429') || initErr?.message?.includes('503')
                    || initErr?.message?.includes('rate limit') || initErr?.message?.includes('Service Unavailable');
                if (is429or503) {
                    aiGateway.recordFailure('gemini');
                    await logger.warn(`⚡ Gemini unavailable. Switching to AI Gateway fallback (Groq/OpenRouter)...`);
                    const fallbackMessages = [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: message }
                    ];
                    const fallbackResult = await aiGateway.agentChat(fallbackMessages, this.tools);
                    return fallbackResult.text || '✅ Task completed via fallback provider.';
                }
                throw initErr;
            }

            // [AGENTIC LOOP] Max 3 rounds — one for the task, one for edge cases, one for recovery
            let response = result.response;
            let allSummaries = [];
            let rounds = 0;
            const MAX_ROUNDS = 3;

            while (rounds < MAX_ROUNDS) {
                rounds++;
                const calls = response.functionCalls();

                if (!calls || calls.length === 0) break; // No more tool calls — we have the answer

                const toolResults = [];
                for (const call of calls) {
                    await logger.info(`🔧 [Round ${rounds}] Calling tool: ${call.name}`);
                    const actionResult = await this.executeTool(userId, call.name, call.args);
                    toolResults.push({
                        functionResponse: {
                            name: call.name,
                            response: { content: actionResult }
                        }
                    });

                    // Clean display for fallback
                    let cleanResult = actionResult;
                    if (call.name === 'list_user_repositories' && typeof actionResult === 'string') {
                        try {
                            const repos = JSON.parse(actionResult);
                            cleanResult = repos.slice(0, 5).map(r => `\`${r.full_name}\` (Last push: ${new Date(r.pushed_at).toLocaleDateString()})`).join('\n');
                            if (repos.length > 5) cleanResult += `\n...and ${repos.length - 5} more.`;
                        } catch(e) {}
                    }
                    allSummaries.push({ tool: call.name, args: call.args, result: cleanResult });
                }

                // Send tool results back — with Gateway fallback if Gemini trips
                let nextResult;
                try {
                    nextResult = await chat.sendMessage(toolResults);
                } catch (roundErr) {
                    const is429or503 = roundErr?.status === 429 || roundErr?.status === 503
                        || roundErr?.message?.includes('429') || roundErr?.message?.includes('503')
                        || roundErr?.message?.includes('rate limit') || roundErr?.message?.includes('Service Unavailable');
                    if (is429or503) {
                        aiGateway.recordFailure('gemini');
                        await logger.warn(`⚡ Gemini rate-limited mid-loop. Falling back to Groq/OpenRouter...`);
                        // Build message history for stateless fallback providers
                        const fbMessages = [
                            { role: 'system', content: systemInstruction },
                            { role: 'user', content: message },
                            ...allSummaries.map(s => ({ role: 'assistant', content: `Executed tool ${s.tool}: ${JSON.stringify(s.result).substring(0, 200)}` }))
                        ];
                        const fbResult = await aiGateway.agentChat(fbMessages, this.tools);
                        return fbResult.text || `✅ Completed ${allSummaries.length} action(s) via fallback provider.`;
                    }
                    throw roundErr;
                }
                response = nextResult.response;
            }

            const finalText = response.text();
            if (!finalText || finalText.trim() === '') {
                await logger.info('⚠️ Agentic loop finished with no text. Building clean fallback...');
                const summaryLines = allSummaries.map(s => `### 🛠️ Tool: \`${s.tool}\`\n${s.result}`);
                return `✅ **Execution Complete!**\n\n${summaryLines.join('\n\n')}\n\n_Ulla completed ${allSummaries.length} action(s)._`;
            }

            return finalText;
        } catch (error) {
            console.error('🔥 Chat Error:', error);
            await logger.error(`🧠 Neural block: ${error.message}`);
            return `❌ I hit a neural block: ${error.message}`;
        }
    }

    /**
     * Executes an approved intelligence plan step by step.
     */
    async executePlan(userId, plan) {
        logger.setContext(userId, null, 'plan-executor');
        await logger.info(`⚙️ Executing approved plan: ${plan.plan.length} steps...`);

        const results = [];
        for (const step of plan.plan) {
            await logger.info(`🛠️ Step ${step.step}: ${step.description}`);
            try {
                await this.executeTool(userId, step.action, {
                    repoName: step.target || '',
                });
                results.push(`✅ Step ${step.step}: ${step.description}`);
                await logger.info(`✅ Step ${step.step} complete.`);
            } catch (e) {
                results.push(`⚠️ Step ${step.step}: ${step.description} → Failed (${e.message})`);
                await logger.warn(`⚠️ Step ${step.step} failed: ${e.message}`);
            }
        }

        await logger.success('✅ Plan execution complete!');
        return `**✅ Execution Complete!**\n\n${results.join('\n')}\n\n_All tasks processed. Check your email for detailed reports._`;
    }

    async executeTool(userId, name, args) {
        try {
            // [HARDENING] Dynamically resolve GitHub Client based on user installation
            const installationId = await databaseService.getInstallationIdByRepo(args.repoName || '', userId);
            const client = installationId 
                ? await githubService.getClient(installationId)
                : await githubService.getClientForOrg('ulla-labs');

            switch (name) {
                case 'autonomous_discovery':
                    console.log(`🤖 Agent: Hunting for ${args.topic} repos to ${args.action}...`);
                    
                    // 1. Search
                    const candidates = await githubService.searchRepositories(client, { topic: args.topic, limit: 10 });
                    
                    // 2. Decision
                    const decisionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                    const analysis = await decisionModel.generateContent(`
                        Rank these repos for "${args.topic}". Pick top ${args.count || 3}.
                        Repos: ${JSON.stringify(candidates)}
                        Respond with ONLY a comma-separated list of full_names.
                    `);
                    const selectedNames = analysis.response.text().split(',').map(n => n.trim());

                    // 3. Act & Summarize
                    let summaryTable = `I found and ${args.action}ed ${selectedNames.length} projects. Here is the summary:\n\n| Repository | Stars ⭐ | Forks 🍴 | Description |\n| :--- | :--- | :--- | :--- |\n`;

                    for (const fullName of selectedNames) {
                        const repoData = candidates.find(r => r.full_name === fullName);
                        const [owner, repo] = fullName.split('/');
                        if (args.action === 'star') await githubService.starRepository(client, owner, repo);
                        if (args.action === 'fork') await githubService.forkRepository(client, owner, repo);
                        console.log(`✅ ${args.action}ed ${fullName}`);

                        if (repoData) {
                            const desc = (repoData.description || 'No description').replace(/\|/g, '-').replace(/\n/g, ' ').substring(0, 80);
                            summaryTable += `| [${fullName}](${repoData.url}) | ${repoData.stars} | ${repoData.forks} | ${desc}... |\n`;
                        }
                    }

                    return summaryTable;

                case 'create_repository':
                    logger.setContext(userId, null, 'chat-tool');
                    this.executeRepoCreation(userId, args.prompt, args.techStack);
                    return "Architecture initiated. I am scaffolding the project now... You can watch the real-time logs in the system panel.";

                case 'summarize_latest_commit':
                    return await this.executeSummarizeCommit(args.repoName);

                case 'mail_repo_files':
                    try {
                        const [mOwner, mRepo] = args.repoName.split('/');
                        let filesToMail = args.files || [];
                        if (filesToMail.length === 0) {
                            // Fetch root directory to find important files
                            const { data: rootContents } = await client.rest.repos.getContent({ owner: mOwner, repo: mRepo, path: '' });
                            const importantFiles = rootContents
                                .filter(f => f.type === 'file' && (f.name.match(/\.(js|ts|py|mjs|json|md|yml|yaml)$/) || f.name.includes('config')))
                                .map(f => f.name)
                                .slice(0, 8);
                            filesToMail = importantFiles;
                        }

                        let emailContent = `# 📂 Source Repository: ${args.repoName}\n\n`;
                        emailContent += `_The following source files have been pulled for your review._\n\n---\n\n`;
                        
                        for (const path of filesToMail) {
                            const content = await githubService.getFileContent(client, mOwner, mRepo, path);
                            if (content) {
                                emailContent += `## 📄 File: ${path}\n\`\`\`\n${content}\n\`\`\`\n\n---\n\n`;
                            }
                        }

                        await sendEmail(emailContent, args.repoName);
                        await logger.success(`✉️ Mailed files from ${args.repoName} to your Gmail.`);
                        return `✅ **Success!** I have compiled ${filesToMail.length} source files from \`${args.repoName}\` and mailed the full contents to your configured Gmail address. Check your inbox!`;
                    } catch (e) {
                        return `Failed to mail files: ${e.message}`;
                    }

                case 'mail_custom_content':
                    try {
                        await sendEmail(args.content, args.subject);
                        await logger.success(`✉️ Mailed custom content (${args.subject}) to your Gmail.`);
                        return `✅ **Success!** I have emailed the custom generated content "${args.subject}" directly to your configured Gmail address. Check your inbox!`;
                    } catch (e) {
                        return `Failed to send custom email: ${e.message}`;
                    }

                case 'review_pull_request':
                    return await advancedWorkflowsService.reviewPullRequest(args.repoName, args.prNumber);

                case 'update_dependencies':
                    return await advancedWorkflowsService.checkDependencies(args.repoName);

                case 'check_repo_health':
                    return await advancedWorkflowsService.checkRepoHealth(args.repoName);

                case 'generate_changelog':
                    return await advancedWorkflowsService.generateChangelog(args.repoName);

                case 'clean_stale_issues':
                    return await advancedWorkflowsService.cleanStaleIssues(args.repoName);

                case 'resolve_merge_conflicts':
                    return await advancedWorkflowsService.resolveMergeConflicts(args.repoName, args.prNumber);

                case 'build_feature':
                    try {
                        const [fOwner, fRepo] = args.repoName.split('/');
                        const fClient = await githubService.getClientForOrg(fOwner);
                        const issue = await fClient.rest.issues.create({
                            owner: fOwner,
                            repo: fRepo,
                            title: `🚀 Auto-Build: ${args.featureDescription.substring(0, 50)}`,
                            body: `**Requested via Ulla Chat Interface:**\n\n${args.featureDescription}\n\n*(The Sentinel brain will pick this up automatically)*`,
                            labels: ['ulla-build']
                        });
                        return `I have initiated the build process! I created Issue #${issue.data.number} on ${args.repoName} and my Sentinel brain is already analyzing the codebase in the background. I will let you know on the GitHub issue when the PR is ready or if I need routing instructions!`;
                    } catch (e) {
                        return `Failed to initiate feature build: ${e.message}`;
                    }

                case 'get_repository_readme':
                    try {
                        const [rOwner, rRepo] = args.repoName.split('/');
                        const rClient = await githubService.getClientForOrg(rOwner);
                        return await githubService.getReadme(rClient, rOwner, rRepo);
                    } catch (e) {
                        return `Failed to fetch README: ${e.message}`;
                    }

                case 'list_user_repositories':
                    try {
                        const repos = await githubService.listUserRepos(client);
                        return JSON.stringify(repos);
                    } catch (e) {
                        return `Failed to list repositories: ${e.message}`;
                    }

                case 'delete_repository':
                    try {
                        const [dOwner, dRepo] = args.repoName.split('/');
                        const dClient = await githubService.getClientForOrg(dOwner);
                        await githubService.deleteRepository(dClient, dOwner, dRepo);
                        return `Successfully DELETED repository: ${args.repoName}`;
                    } catch (e) {
                        return `Failed to delete repository: ${e.message}`;
                    }

                case 'push_custom_file':
                    try {
                        const [pOwner, pRepo] = args.repoName.split('/');
                        const pClient = await githubService.getClientForOrg(pOwner);
                        await githubService.pushFile(pClient, pOwner, pRepo, args.path, args.content, args.commitMessage);
                        await logger.success(`✅ Successfully pushed file "${args.path}" to ${args.repoName}`);
                        return `Success: I have pushed the file "${args.path}" to ${args.repoName} with the following commit message: "${args.commitMessage}".`;
                    } catch (e) {
                        return `Failed to push custom file: ${e.message}`;
                    }

                case 'audit_all_repos':
                    try {
                        const allRepos = await githubService.listUserRepos(client);
                        await logger.info(`🔍 Cross-repo audit started for ${allRepos.length} repositories...`);
                        const auditResults = [];
                        // Audit top 5 most recently active repos to avoid rate limiting
                        const topRepos = allRepos
                            .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
                            .slice(0, 5);
                        for (const repo of topRepos) {
                            const health = await advancedWorkflowsService.checkRepoHealth(repo.full_name);
                            auditResults.push(`### ${repo.full_name}\n${health}`);
                        }
                        await logger.success('✅ Cross-repo audit complete!');
                        return auditResults.join('\n\n---\n\n');
                    } catch (e) {
                        return `Audit failed: ${e.message}`;
                    }

                case 'enable_autopilot':
                    this.autopilotActive = true;
                    await logger.success('✅ Autopilot Mode activated!');
                    return `**🛰️ Autopilot Mode Activated!**\n\nI am now your full-time DevOps engineer. Here is what I will do continuously:\n\n- **Hourly:** Security scan across all repos\n- **Daily:** Dependency updates → auto-merge if tests pass\n- **Weekly:** Close stale issues, archive dead repos\n- **On every PR:** Automated code review\n\nYou can check the SYSTEM_LOGS panel at any time to see what I'm working on. Say **"disable autopilot"** to stop.`;

                default:
                    return "Error: Unknown tool.";
            }
        } catch (e) {
            return `Error: ${e.message}`;
        }
    }

    async executeRepoCreation(userId, prompt, techStack) {
        try {
            logger.setContext(userId, null, 'repo-creator');
            await logger.info(`🏗️ Starting project scaffolding: ${prompt}`);
            
            const client = await githubService.getClientForOrg('ulla-labs');
            const repoName = prompt.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
            
            await logger.info(`🛰️ Creating GitHub repository: ulla-labs/${repoName}`);
            const repo = await githubService.createRepository(client, repoName, prompt, 'ulla-labs');
            
            await logger.info(`📂 Generating code for ${techStack} stack...`);
            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            
            const fileCount = Object.keys(files).length;
            let current = 0;
            for (const [path, content] of Object.entries(files)) {
                current++;
                await logger.info(`📤 Pushing files: [${current}/${fileCount}] ${path}`);
                await githubService.pushFile(client, repo.owner.login, repo.name, path, content, '🚀 Initial Scaffold');
            }
            
            await logger.success(`✅ Project Fully Scaffolled! Repository is live at ${repo.html_url}`);
        } catch (error) {
            await logger.error(`❌ Async Repo Creation Failed: ${error.message}`);
            console.error('❌ Async Repo Creation Failed:', error);
        }
    }

    async executeSummarizeCommit(repoFullName) {
        try {
            if (!repoFullName.includes('/')) {
                repoFullName = `ulla-labs/${repoFullName}`;
            }
            const [owner, repo] = repoFullName.split('/');
            const client = await githubService.getClientForOrg('ulla-labs');

            const { data: commits } = await client.rest.repos.listCommits({ owner, repo, per_page: 1 });
            if (!commits || commits.length === 0) return "No commits found in this repository.";
            const latestCommit = commits[0];

            const { data: commitDetail } = await client.rest.repos.getCommit({ owner, repo, ref: latestCommit.sha });

            const summarizeModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const prompt = `
                Analyze this commit and generate a professional Markdown report.
                Message: ${commitDetail.commit.message}
                Author: ${commitDetail.commit.author.name}
                Files changed: ${commitDetail.files.map(f => f.filename).join(', ')}
                Diff snippet: ${commitDetail.files[0]?.patch?.substring(0, 500) || 'No diff available'}
                
                Make the report detailed and insightful.
            `;
            const analysis = await summarizeModel.generateContent(prompt);
            const reportMarkdown = analysis.response.text();

            await sendEmail(reportMarkdown, repoFullName);

            return "Success: The latest commit has been summarized and the report was emailed successfully.";
        } catch (error) {
            console.error('❌ Summarize Commit Failed:', error);
            return `Failed to summarize commit: ${error.message}`;
        }
    }
}

export default new ChatService();
