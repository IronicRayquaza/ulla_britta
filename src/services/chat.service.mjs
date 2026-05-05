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
                        description: "Scaffolds a NEW project.",
                        parameters: {
                            type: "object",
                            properties: { prompt: { type: "string" }, techStack: { type: "string" } },
                            required: ["prompt", "techStack"]
                        }
                    }
                ]
            }
        ];

        this.model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', tools: this.tools });
    }

    async processMessage(userId, message) {
        try {
            const context = await databaseService.getRecentActivity(userId, 5);
            const chat = this.model.startChat();

            const prompt = `You are Ulla Britta. Status: ${JSON.stringify(context)}. User: ${message}`;
            let result = await chat.sendMessage(prompt);
            let response = result.response;
            const call = response.functionCalls()?.[0];

            if (call) {
                const toolResult = await this.executeTool(userId, call.name, call.args);
                const finalResult = await chat.sendMessage([{
                    functionResponse: { name: call.name, response: { content: toolResult } }
                }]);
                return finalResult.response.text();
            }

            return response.text();
        } catch (error) {
            return `❌ Neural Block: ${error.message}`;
        }
    }

    async executeTool(userId, name, args) {
        const fallbackId = '125781221';
        const client = await githubService.getClient(fallbackId);

        if (name === 'autonomous_discovery') {
            console.log(`🤖 Agent: Hunting for ${args.topic} repos to ${args.action}...`);
            
            // 1. Search
            const candidates = await githubService.searchRepositories(client, { topic: args.topic, limit: 10 });
            
            // 2. Decision (Internal AI Ranking)
            const decisionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
        }

        if (name === 'create_repository') {
            this.executeRepoCreation(userId, args.prompt, args.techStack);
            return "Architecture initiated. Check GitHub in a moment.";
        }
    }

    async executeRepoCreation(userId, prompt, techStack) {
        try {
            const fallbackId = '125781221';
            const client = await githubService.getClient(fallbackId);
            const repoName = prompt.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
            const repo = await githubService.createRepository(client, repoName, prompt, 'Ulla-Labs'); // Using your Org
            const files = await repoCreatorService.scaffoldProject(prompt, techStack);
            for (const file of files) {
                await githubService.pushFile(client, 'Ulla-Labs', repo.name, file.path, file.content, '🚀 Initial Scaffold');
            }
        } catch (error) {
            console.error('❌ Repo Creation Failed:', error);
        }
    }
}

export default new ChatService();
