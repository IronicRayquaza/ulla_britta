import { GoogleGenerativeAI } from '@google/generative-ai';
import repoCreatorService from './repo-creator.service.mjs';
import databaseService from './database.service.mjs';
import githubService from './github.service.mjs';

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

                    // 3. Act
                    for (const fullName of selectedNames) {
                        const [owner, repo] = fullName.split('/');
                        if (args.action === 'star') await githubService.starRepository(client, owner, repo);
                        if (args.action === 'fork') await githubService.forkRepository(client, owner, repo);
                        console.log(`✅ ${args.action}ed ${fullName}`);
                    }

                    return `I found and ${args.action}ed ${selectedNames.length} projects: ${selectedNames.join(', ')}`;

                case 'create_repository':
                    this.executeRepoCreation(userId, args.prompt, args.techStack);
                    return "Architecture initiated. Check GitHub in a moment.";

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
            
            for (const file of files) {
                await githubService.pushFile(client, repo.owner.login, repo.name, file.path, file.content, '🚀 Initial Scaffold');
            }
        } catch (error) {
            console.error('❌ Async Repo Creation Failed:', error);
        }
    }
}

export default new ChatService();
