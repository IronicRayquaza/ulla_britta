import { GoogleGenerativeAI } from '@google/generative-ai';
import repoCreatorService from './repo-creator.service.mjs';
import databaseService from './database.service.mjs';
import githubService from './github.service.mjs';
import { sendEmail } from './email.service.mjs';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Integrated Chat Agent with "Search & Act" Autonomy
 */
class ChatService {
    constructor() {
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
                    }
                ]
            }
        ];

        // LOCKED TO GEMINI 3 FLASH PREVIEW
        this.model = genAI.getGenerativeModel({ 
            model: 'gemini-3-flash-preview',
            tools: this.tools
        });
    }

    async processMessage(userId, message) {
        try {
            const context = await databaseService.getRecentActivity(userId, 5);
            const chat = this.model.startChat();

            const systemInstruction = `
                You are Ulla Britta, a Smart SRE Agent. 
                YOU HAVE AUTONOMY. If a user asks to "fork some repos" or "find something," use the 'autonomous_discovery' tool to search, analyze, and act.
                DO NOT BE DEPENDENT. If you can find the info yourself, do it.
                
                Current Status: ${JSON.stringify(context)}
            `;

            let result = await chat.sendMessage([
                { text: systemInstruction },
                { text: message }
            ]);

            let response = result.response;
            const calls = response.functionCalls();
            
            if (calls && calls.length > 0) {
                const toolResults = [];
                for (const call of calls) {
                    const actionResult = await this.executeTool(userId, call.name, call.args);
                    toolResults.push({
                        functionResponse: {
                            name: call.name,
                            response: { content: actionResult }
                        }
                    });
                }
                
                const finalResult = await chat.sendMessage(toolResults);
                return finalResult.response.text();
            }

            return response.text();
        } catch (error) {
            console.error('🔥 Chat Error:', error);
            return `❌ I hit a neural block: ${error.message}`;
        }
    }

    async executeTool(userId, name, args) {
        try {
            const client = await githubService.getClientForOrg('ulla-labs');

            switch (name) {
                case 'autonomous_discovery':
                    console.log(`🤖 Agent: Hunting for ${args.topic} repos to ${args.action}...`);
                    
                    // 1. Search
                    const candidates = await githubService.searchRepositories(client, { topic: args.topic, limit: 10 });
                    
                    // 2. Decision
                    const decisionModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
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
                    this.executeRepoCreation(userId, args.prompt, args.techStack);
                    return "Architecture initiated. Check GitHub in a moment.";

                case 'summarize_latest_commit':
                    return await this.executeSummarizeCommit(args.repoName);

                default:
                    return "Error: Unknown tool.";
            }
        } catch (e) {
            return `Error: ${e.message}`;
        }
    }

    async executeRepoCreation(userId, prompt, techStack) {
        try {
            const client = await githubService.getClientForOrg('ulla-labs');
            const repoName = prompt.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
            
            const repo = await githubService.createRepository(client, repoName, prompt, 'ulla-labs');
            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            
            for (const [path, content] of Object.entries(files)) {
                await githubService.pushFile(client, repo.owner.login, repo.name, path, content, '🚀 Initial Scaffold');
            }
        } catch (error) {
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

            const summarizeModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
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
